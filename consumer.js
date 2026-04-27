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
  const { data: trip } = await supabase.from('trips').insert({
    vehicle_id: vehicleId,
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

// ── PAYLOAD PROCESSOR ──
// Handles both proto JSON format {key, value: {floatValue: x}}
// and simplified format {key, value: x}

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
// Reads JSON lines from fleet-telemetry Go server (piped via stdout)
// App logs have no 'vin'; telemetry records do.

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line) => {
  if (!line.trim()) return
  try {
    const record = JSON.parse(line)
    if (!record.vin) return
    await processTelemetryPayload(record)
  } catch {
    // ignore parse errors from non-JSON log lines
  }
})

rl.on('close', () => {
  console.error('stdin closed — fleet-telemetry process exited')
  process.exit(0)
})

console.error('Consumer ready — reading telemetry from fleet-telemetry server')
