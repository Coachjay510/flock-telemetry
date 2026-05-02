import { createClient } from '@supabase/supabase-js'
import { createInterface } from 'readline'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const FIELD_MAP = {
  'Location':                   handleLocation,
  'VehicleSpeed':               handleSpeed,
  'Heading':                    handleHeading,
  'BatteryLevel':               handleBattery,
  'ChargingState':              handleChargingState,
  'Gear':                       handleGear,
  'Odometer':                   handleOdometer,
  'ForwardCollisionWarning':    handleCollisionWarning,
  'LaneDepartureAvoidance':     handleLaneDeparture,
  'AutopilotEnabled':           handleAutopilot,
  'AutopilotState':             handleAutopilotState,
  'TurnSignalLeft':             handleTurnSignal,
  'TurnSignalRight':            handleTurnSignal,
}

const vehicleState = {}

function getState(vin) {
  if (!vehicleState[vin]) {
    vehicleState[vin] = {
      vin,
      lat: null, lng: null, speed: 0, heading: 0,
      battery: null, chargingState: null,
      gear: null, odometer: null,
      autopilotEnabled: false, autopilotState: null,
      autopilotDistance: 0, manualDistance: 0,
      collisionWarnings: 0, laneDepartures: 0,
      turnSignalLeft: false, turnSignalRight: false,
      lastOdometer: null, lastGear: null,
      activeTripId: null, tripStartOdometer: null,
      lastWritten: 0,
      lastStreetOdometer: null,
      lastLocationOdometer: null,
    }
  }
  return vehicleState[vin]
}

async function handleLocation(vin, value) {
  const s = getState(vin)
  if (value?.latitude) s.lat = value.latitude
  if (value?.longitude) s.lng = value.longitude
  await maybeWriteLocation(vin)
}

async function handleSpeed(vin, value) {
  getState(vin).speed = value || 0
}

async function handleHeading(vin, value) {
  getState(vin).heading = value || 0
}

async function handleBattery(vin, value) {
  getState(vin).battery = value
}

async function handleChargingState(vin, value) {
  getState(vin).chargingState = value
}

async function handleGear(vin, value) {
  const s = getState(vin)
  const prevGear = s.gear
  s.gear = value
  const isDriving = ['D','R','N'].includes(value)
  const wasDriving = ['D','R','N'].includes(prevGear)
  if (isDriving && !wasDriving) await startTrip(vin, s)
  else if (!isDriving && wasDriving && s.activeTripId) await endTrip(vin, s)
}

async function handleOdometer(vin, value) {
  const s = getState(vin)
  const prev = s.odometer
  if (prev && value && value > prev) {
    const delta = value - prev
    if (s.autopilotEnabled) s.autopilotDistance += delta
    else s.manualDistance += delta
    if (s.activeTripId && s.lat && s.lng) await writeTripPoint(vin, s)
    await updateDrivingStats(vin, s)
    await maybeLogStreet(vin, s)
    await maybeLogLocationVisit(vin, s)
  }
  s.lastOdometer = s.odometer
  s.odometer = value
}

async function handleCollisionWarning(vin, value) {
  const s = getState(vin)
  if (value && value !== 'None' && value !== false) {
    s.collisionWarnings++
    console.error(`⚠️  Collision warning ${vin}: ${value} (total: ${s.collisionWarnings})`)
    await supabase.from('vehicle_safety_events').insert({
      vehicle_id: await getVehicleId(vin),
      event_type: 'collision_warning',
      value: String(value),
      timestamp: new Date().toISOString()
    })
    await updateSafetyStats(vin, s)
  }
}

async function handleLaneDeparture(vin, value) {
  const s = getState(vin)
  if (value && value !== 'None' && value !== 'LaneDepartureAvoidanceStateOff') {
    s.laneDepartures++
    console.error(`⚠️  Lane departure ${vin}: ${value} (total: ${s.laneDepartures})`)
    await supabase.from('vehicle_safety_events').insert({
      vehicle_id: await getVehicleId(vin),
      event_type: 'lane_departure',
      value: String(value),
      timestamp: new Date().toISOString()
    })
    await updateSafetyStats(vin, s)
  }
}

async function handleAutopilot(vin, value) {
  getState(vin).autopilotEnabled = value === true || value === 'true'
}

async function handleAutopilotState(vin, value) {
  getState(vin).autopilotState = value
}

async function handleTurnSignal(vin, value, field) {
  const s = getState(vin)
  if (field === 'TurnSignalLeft') s.turnSignalLeft = !!value
  if (field === 'TurnSignalRight') s.turnSignalRight = !!value
  await maybeWriteLocation(vin)
}

// ── DB HELPERS ──

const vehicleIdCache = {}
async function getVehicleId(vin) {
  if (vehicleIdCache[vin]) return vehicleIdCache[vin]
  const { data } = await supabase.from('vehicles').select('id').eq('vin', vin).single()
  if (data) vehicleIdCache[vin] = data.id
  return data?.id
}

const ownerCache = {}
async function getOwner(vin) {
  if (ownerCache[vin]) return ownerCache[vin]
  const vehicleId = await getVehicleId(vin)
  if (!vehicleId) return null
  const { data } = await supabase.from('vehicles').select('owner_id').eq('id', vehicleId).single()
  if (data?.owner_id) ownerCache[vin] = data.owner_id
  return data?.owner_id || null
}

async function maybeWriteLocation(vin) {
  const s = getState(vin)
  if (!s.lat || !s.lng) return
  const now = Date.now()
  if (now - s.lastWritten < 5000) return
  s.lastWritten = now
  const vehicleId = await getVehicleId(vin)
  if (!vehicleId) return
  await supabase.from('vehicle_locations').insert({
    vehicle_id: vehicleId,
    latitude: s.lat,
    longitude: s.lng,
    speed: s.speed || 0,
    battery_percent: s.battery,
    heading: s.heading || 0,
    turn_signal_left: s.turnSignalLeft,
    turn_signal_right: s.turnSignalRight,
    autopilot_active: s.autopilotEnabled,
    timestamp: new Date().toISOString()
  })
}

async function writeTripPoint(vin, s) {
  const vehicleId = await getVehicleId(vin)
  if (!vehicleId || !s.activeTripId) return
  await supabase.from('trip_points').insert({
    trip_id: s.activeTripId,
    vehicle_id: vehicleId,
    latitude: s.lat,
    longitude: s.lng,
    timestamp: new Date().toISOString()
  })
}

async function startTrip(vin, s) {
  const vehicleId = await getVehicleId(vin)
  if (!vehicleId) return
  const { data: activeDriver } = await supabase.from('vehicle_active_drivers')
    .select('driver_id').eq('vehicle_id', vehicleId).maybeSingle()
  const { data: trip } = await supabase.from('trips').insert({
    vehicle_id: vehicleId,
    driver_id: activeDriver?.driver_id || null,
    start_time: new Date().toISOString(),
    start_location: s.lat && s.lng ? `${s.lat},${s.lng}` : null
  }).select().single()
  if (trip) {
    s.activeTripId = trip.id
    s.tripStartOdometer = s.odometer
    console.error(`🚗 Trip started: ${vin} tripId=${trip.id}`)
  }
}

async function endTrip(vin, s) {
  const vehicleId = await getVehicleId(vin)
  if (!vehicleId || !s.activeTripId) return
  const distance = s.tripStartOdometer && s.odometer
    ? Math.round((s.odometer - s.tripStartOdometer) * 100) / 100
    : null
  await supabase.from('trips').update({
    end_time: new Date().toISOString(),
    end_location: s.lat && s.lng ? `${s.lat},${s.lng}` : null,
    distance_miles: distance
  }).eq('id', s.activeTripId)
  console.error(`🏁 Trip ended: ${vin} distance=${distance}mi`)
  s.activeTripId = null
  s.tripStartOdometer = null
  if (distance) await awardTripXp(vin, distance)
}

async function updateDrivingStats(vin, s) {
  const vehicleId = await getVehicleId(vin)
  if (!vehicleId) return
  await supabase.from('vehicle_driving_stats').upsert({
    vehicle_id: vehicleId,
    autopilot_miles: s.autopilotDistance,
    manual_miles: s.manualDistance,
    updated_at: new Date().toISOString()
  }, { onConflict: 'vehicle_id' })
}

async function updateSafetyStats(vin, s) {
  const vehicleId = await getVehicleId(vin)
  if (!vehicleId) return
  await supabase.from('vehicle_safety_stats').upsert({
    vehicle_id: vehicleId,
    collision_warnings: s.collisionWarnings,
    lane_departures: s.laneDepartures,
    updated_at: new Date().toISOString()
  }, { onConflict: 'vehicle_id' })
}

// ── GAMIFICATION ──

const LEVELS = [
  { level: 1, xp: 0 }, { level: 2, xp: 200 }, { level: 3, xp: 500 },
  { level: 4, xp: 1000 }, { level: 5, xp: 2000 }, { level: 6, xp: 3500 },
  { level: 7, xp: 5500 }, { level: 8, xp: 8000 }, { level: 9, xp: 11000 },
  { level: 10, xp: 15000 },
]

function computeLevel(xp) {
  let level = 1
  for (const l of LEVELS) { if (xp >= l.xp) level = l.level }
  return level
}

const BADGE_REQS = [
  { name: '100 Miles',    icon: '🛣️', rarity: 'common',    xp: 50,   req: { type: 'miles',  value: 100 } },
  { name: '500 Miles',    icon: '🗺️', rarity: 'rare',      xp: 150,  req: { type: 'miles',  value: 500 } },
  { name: '1,000 Miles',  icon: '🌎', rarity: 'epic',      xp: 400,  req: { type: 'miles',  value: 1000 } },
  { name: '5,000 Miles',  icon: '🌍', rarity: 'legendary', xp: 1000, req: { type: 'miles',  value: 5000 } },
  { name: '10 Trips',     icon: '🚗', rarity: 'common',    xp: 50,   req: { type: 'trips',  value: 10 } },
  { name: '50 Trips',     icon: '🚘', rarity: 'rare',      xp: 150,  req: { type: 'trips',  value: 50 } },
  { name: '100 Trips',    icon: '🏁', rarity: 'epic',      xp: 400,  req: { type: 'trips',  value: 100 } },
  { name: '500 Trips',    icon: '🏆', rarity: 'legendary', xp: 1000, req: { type: 'trips',  value: 500 } },
]

async function checkAndAwardBadges(userId, totalMiles, totalTrips) {
  const { data: existing } = await supabase.from('user_badges').select('badge_name').eq('user_id', userId)
  const earned = new Set((existing || []).map(b => b.badge_name))
  const toAward = []
  let bonusXp = 0
  for (const badge of BADGE_REQS) {
    if (earned.has(badge.name)) continue
    const { type, value } = badge.req
    const qualifies = (type === 'miles' && totalMiles >= value) || (type === 'trips' && totalTrips >= value)
    if (qualifies) {
      toAward.push({ user_id: userId, badge_name: badge.name, icon: badge.icon, rarity: badge.rarity, xp_earned: badge.xp, unlocked_at: new Date().toISOString() })
      bonusXp += badge.xp
      console.error(`🏅 Badge unlocked: ${badge.name} for ${userId} (+${badge.xp} XP)`)
    }
  }
  if (toAward.length > 0) await supabase.from('user_badges').insert(toAward)
  return bonusXp
}

async function updateActiveChallenges(userId, totalMiles, totalTrips, totalStreets, totalXp) {
  const { data: challenges } = await supabase.from('family_challenges').select('id, type').eq('status', 'active')
  if (!challenges?.length) return
  for (const c of challenges) {
    const score =
      c.type === 'most_miles'   ? totalMiles :
      c.type === 'most_trips'   ? totalTrips :
      c.type === 'most_streets' ? totalStreets :
      c.type === 'most_xp'      ? totalXp : 0
    await supabase.from('challenge_entries').upsert(
      { challenge_id: c.id, user_id: userId, score, updated_at: new Date().toISOString() },
      { onConflict: 'challenge_id,user_id' }
    )
  }
}

async function awardTripXp(vin, tripMiles) {
  const ownerId = await getOwner(vin)
  if (!ownerId) return

  const { data: member } = await supabase.from('family_members')
    .select('xp, total_miles, total_trips').eq('id', ownerId).single()
  if (!member) return

  const newMiles = (member.total_miles || 0) + tripMiles
  const newTrips = (member.total_trips || 0) + 1
  const tripXp   = 10 + Math.floor(tripMiles)
  const bonusXp  = await checkAndAwardBadges(ownerId, newMiles, newTrips)
  const newXp    = (member.xp || 0) + tripXp + bonusXp
  const level    = computeLevel(newXp)

  await supabase.from('family_members').update({ xp: newXp, level, total_miles: newMiles, total_trips: newTrips }).eq('id', ownerId)
  await supabase.from('xp_events').insert({ user_id: ownerId, amount: tripXp, reason: `Trip (${tripMiles.toFixed(1)} mi)`, created_at: new Date().toISOString() })

  const { count: streetCount } = await supabase.from('user_street_progress')
    .select('*', { count: 'exact', head: true }).eq('user_id', ownerId).eq('completed', true)
  await updateActiveChallenges(ownerId, newMiles, newTrips, streetCount || 0, newXp)
  console.error(`⭐ XP: ${ownerId} +${tripXp}trip +${bonusXp}badge = ${newXp} total`)
}

// ── STREET LOGGING ──

const TREE_WORDS = new Set(['oak','maple','pine','elm','cedar','birch','willow','walnut','cherry','ash','cypress','magnolia','poplar','spruce','hickory','chestnut','sycamore','pecan','cottonwood','redwood'])
const PRES_NAMES = new Set(['washington','lincoln','jefferson','adams','madison','monroe','jackson','harrison','tyler','polk','taylor','fillmore','pierce','buchanan','cleveland','garfield','arthur','mckinley','roosevelt','taft','wilson','harding','coolidge','hoover','truman','eisenhower','kennedy','johnson','nixon','ford','carter','reagan','clinton','obama','trump','biden'])
const COLOR_WORDS = new Set(['red','blue','green','yellow','orange','purple','white','black','silver','gold','brown','gray','grey','violet','indigo','scarlet','crimson','azure'])

function categorizeStreet(name) {
  const words = name.toLowerCase().split(/[\s,\-]+/)
  if (words.some(w => TREE_WORDS.has(w))) return 'tree'
  if (words.some(w => PRES_NAMES.has(w))) return 'presidential'
  if (/^\d+(st|nd|rd|th)/i.test(name)) return 'numbered_first'
  if (words.some(w => COLOR_WORDS.has(w))) return 'color'
  return null
}

// Nominatim requires 1 req/sec — track last call time
let lastGeocodeMs = 0

async function maybeLogStreet(vin, s) {
  if (!s.lat || !s.lng || !s.odometer) return
  const lastOdo = s.lastStreetOdometer || 0
  if (s.odometer - lastOdo < 0.25) return  // geocode every ~0.25 miles
  s.lastStreetOdometer = s.odometer

  const ownerId = await getOwner(vin)
  if (!ownerId) return

  // Throttle to 1 req/sec for Nominatim ToS compliance
  const now = Date.now()
  const wait = 1100 - (now - lastGeocodeMs)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastGeocodeMs = Date.now()

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${s.lat}&lon=${s.lng}&format=json`,
      { headers: { 'User-Agent': 'FlockApp/1.0 (reg2point1@gmail.com)' } }
    )
    const geo = await res.json()
    const road = geo?.address?.road
    if (!road) return

    const category = categorizeStreet(road)
    if (!category) return

    const { data: existing } = await supabase.from('user_street_progress')
      .select('id').eq('user_id', ownerId).eq('street_name', road).maybeSingle()
    if (existing) return

    await supabase.from('user_street_progress').insert({
      user_id: ownerId,
      street_name: road,
      category,
      completed: true,
      first_driven_at: new Date().toISOString()
    })
    console.error(`🌳 Street: ${road} (${category}) → ${ownerId}`)
  } catch {
    // network error or rate limit — skip silently
  }
}

// ── LOCATION GROUP VISITS ──

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

let groupLocationsCache = null
let groupLocationsCacheAt = 0
async function getGroupLocations() {
  const now = Date.now()
  if (groupLocationsCache && now - groupLocationsCacheAt < 10 * 60 * 1000) return groupLocationsCache
  const { data } = await supabase.from('group_locations').select('id, group_id, name, lat, lng, radius_meters')
  groupLocationsCache = data || []
  groupLocationsCacheAt = now
  return groupLocationsCache
}

async function maybeLogLocationVisit(vin, s) {
  if (!s.lat || !s.lng || !s.odometer) return
  const lastOdo = s.lastLocationOdometer || 0
  if (s.odometer - lastOdo < 0.25) return
  s.lastLocationOdometer = s.odometer

  const ownerId = await getOwner(vin)
  if (!ownerId) return

  const locations = await getGroupLocations()
  if (!locations.length) return

  for (const loc of locations) {
    const dist = haversineMeters(s.lat, s.lng, Number(loc.lat), Number(loc.lng))
    if (dist > loc.radius_meters) continue

    const { data: newVisit, error } = await supabase
      .from('user_location_visits')
      .insert({ user_id: ownerId, location_id: loc.id })
      .select('id')
      .maybeSingle()

    if (error && error.code !== '23505') {
      console.error(`Location visit insert error: ${error.message}`)
      continue
    }

    if (newVisit) {
      console.error(`📍 Location visit: ${loc.name} → ${ownerId}`)
      await checkLocationGroupCompletion(ownerId, loc.group_id)
    }
  }
}

async function checkLocationGroupCompletion(userId, groupId) {
  const { count: total } = await supabase
    .from('group_locations')
    .select('*', { count: 'exact', head: true })
    .eq('group_id', groupId)

  if (!total) return

  const { count: visited } = await supabase
    .from('user_location_visits')
    .select('*, group_locations!inner(group_id)', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('group_locations.group_id', groupId)

  if (visited < total) {
    console.error(`📍 Group progress: ${visited}/${total} for group ${groupId}`)
    return
  }

  const { data: group } = await supabase
    .from('location_groups')
    .select('name, badge_rarity, xp_reward')
    .eq('id', groupId)
    .single()

  if (!group) return

  const { error: badgeErr } = await supabase
    .from('user_badges')
    .insert({ user_id: userId, badge_name: group.name, category: 'location_group', unlocked_at: new Date().toISOString() })

  if (badgeErr && badgeErr.code !== '23505') {
    console.error(`Location group badge insert error: ${badgeErr.message}`)
    return
  }

  if (!badgeErr) {
    console.error(`🏅 Location group badge: "${group.name}" for ${userId} (+${group.xp_reward} XP)`)
    const { data: member } = await supabase.from('family_members').select('xp').eq('id', userId).single()
    if (member) {
      const newXp = (member.xp || 0) + group.xp_reward
      const level = computeLevel(newXp)
      await supabase.from('family_members').update({ xp: newXp, level }).eq('id', userId)
      await supabase.from('xp_events').insert({ user_id: userId, amount: group.xp_reward, reason: `Badge: ${group.name}`, created_at: new Date().toISOString() })
    }
  }
}

// ── PAYLOAD PROCESSOR ──

async function processTelemetryPayload(payload) {
  const vin = payload.vin
  if (!vin) return

  const data = payload.data || []
  for (const field of data) {
    const fieldName = field.key
    const raw = field.value
    const value = raw?.stringValue
      ?? raw?.doubleValue
      ?? raw?.floatValue
      ?? raw?.intValue
      ?? raw?.int32Value
      ?? raw?.booleanValue
      ?? raw?.locationValue
      ?? raw

    const handler = FIELD_MAP[fieldName]
    if (handler) {
      try {
        await handler(vin, value, fieldName)
      } catch (err) {
        console.error(`Handler error for ${fieldName}:`, err.message)
      }
    }
  }
}

// ── STDIN READER ──

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line) => {
  if (!line.trim()) return
  try {
    const record = JSON.parse(line)
    if (!record.vin) return
    await processTelemetryPayload(record)
  } catch {
    // ignore non-JSON log lines
  }
})

rl.on('close', () => {
  console.error('stdin closed — fleet-telemetry process exited')
  process.exit(0)
})

console.error('Consumer ready — reading telemetry from fleet-telemetry server')
