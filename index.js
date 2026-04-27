import { createClient } from '@supabase/supabase-js'
import { createServer } from 'https'
import { createServer as createHttpServer } from 'http'
import { readFileSync } from 'fs'
import crypto from 'crypto'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── TELEMETRY FIELD HANDLERS ──
// Maps Tesla field names to our DB columns
const FIELD_MAP = {
  // Location
  'Location':                   handleLocation,
  'VehicleSpeed':               handleSpeed,
  'Heading':                    handleHeading,

  // Battery
  'BatteryLevel':               handleBattery,
  'ChargingState':              handleChargingState,

  // Drive
  'Gear':                       handleGear,
  'Odometer':                   handleOdometer,

  // Safety events (counted)
  'ForwardCollisionWarning':    handleCollisionWarning,
  'LaneDepartureAvoidance':     handleLaneDeparture,

  // Autopilot
  'AutopilotEnabled':           handleAutopilot,
  'AutopilotState':             handleAutopilotState,

  // Turn signals
  'TurnSignalLeft':             handleTurnSignal,
  'TurnSignalRight':            handleTurnSignal,
}

// Per-vehicle in-memory state (persisted to Supabase periodically)
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

// ── FIELD HANDLERS ──

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

  if (isDriving && !wasDriving) {
    await startTrip(vin, s)
  } else if (!isDriving && wasDriving && s.activeTripId) {
    await endTrip(vin, s)
  }
}

async function handleOdometer(vin, value) {
  const s = getState(vin)
  const prev = s.odometer

  if (prev && value && value > prev) {
    const delta = value - prev
    if (s.autopilotEnabled) {
      s.autopilotDistance += delta
    } else {
      s.manualDistance += delta
    }
    // Write trip point if driving
    if (s.activeTripId && s.lat && s.lng) {
      await writeTripPoint(vin, s)
    }
    // Update stats in DB
    await updateDrivingStats(vin, s)
  }
  s.lastOdometer = s.odometer
  s.odometer = value
}

async function handleCollisionWarning(vin, value) {
  const s = getState(vin)
  if (value && value !== 'None' && value !== false) {
    s.collisionWarnings++
    console.log(`⚠️ Collision warning for ${vin}: ${value} (total: ${s.collisionWarnings})`)
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
    console.log(`⚠️ Lane departure for ${vin}: ${value} (total: ${s.laneDepartures})`)
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
  const s = getState(vin)
  s.autopilotEnabled = value === true || value === 'true'
  console.log(`🤖 Autopilot ${s.autopilotEnabled ? 'ON' : 'OFF'} for ${vin}`)
}

async function handleAutopilotState(vin, value) {
  getState(vin).autopilotState = value
}

async function handleTurnSignal(vin, value, field) {
  const s = getState(vin)
  if (field === 'TurnSignalLeft') s.turnSignalLeft = !!value
  if (field === 'TurnSignalRight') s.turnSignalRight = !!value
  // Update location with turn signal state
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
  // Throttle location writes to max once per 5s
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
    console.log(`🚗 Trip started: ${vin} tripId=${trip.id}`)
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
  console.log(`🏁 Trip ended: ${vin} distance=${distance}mi`)
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

// ── TELEMETRY PAYLOAD PROCESSOR ──

async function processTelemetryPayload(payload) {
  const vin = payload.vin
  if (!vin) { console.warn('No VIN in payload'); return }

  const data = payload.data || []
  for (const field of data) {
    const fieldName = field.key
    const value = field.value?.stringValue
      ?? field.value?.doubleValue
      ?? field.value?.floatValue
      ?? field.value?.intValue
      ?? field.value?.booleanValue
      ?? field.value?.locationValue
      ?? field.value

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

// ── HTTP SERVER ──
// Railway provides HTTPS termination so we just need HTTP

const server = createHttpServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', vehicles: Object.keys(vehicleState).length }))
    return
  }

  if (req.method === 'POST' && req.url === '/telemetry') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body)
        console.log(`[${new Date().toISOString()}] Telemetry from ${payload.vin}: ${(payload.data||[]).map(d=>d.key).join(', ')}`)
        await processTelemetryPayload(payload)
        res.writeHead(200)
        res.end('OK')
      } catch (err) {
        console.error('Parse error:', err.message)
        res.writeHead(400)
        res.end('Bad Request')
      }
    })
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Tesla telemetry server listening on port ${PORT}`)
  console.log('Endpoints: POST /telemetry | GET /health')
})
