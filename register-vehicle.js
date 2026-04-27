// Register Fleet Telemetry config per-vehicle via Tesla Fleet API
// node register-vehicle.js

const TESLA_CLIENT_ID     = process.env.TESLA_CLIENT_ID
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET
const TELEMETRY_HOST      = 'flock-telemetry-production.up.railway.app'

// CA cert from Railway's TLS chain (Certainly Intermediate R1 → Starfield Root G2)
const RAILWAY_CA = `-----BEGIN CERTIFICATE-----
MIIEoDCCA4igAwIBAgIIEYMc3ky1c+UwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNV
BAYTAlVTMRAwDgYDVQQIEwdBcml6b25hMRMwEQYDVQQHEwpTY290dHNkYWxlMSUw
IwYDVQQKExxTdGFyZmllbGQgVGVjaG5vbG9naWVzLCBJbmMuMTIwMAYDVQQDEylT
dGFyZmllbGQgUm9vdCBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkgLSBHMjAeFw0yMjA2
MjIwMDAwMDBaFw0zMjA2MjEyMzU5NTlaMEUxCzAJBgNVBAYTAlVTMRIwEAYDVQQK
EwlDZXJ0YWlubHkxIjAgBgNVBAMTGUNlcnRhaW5seSBJbnRlcm1lZGlhdGUgUjEw
ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCW0khmsa1kAMrw6Q6kPsiZ
6LfWXQcpcDnu1+Ql7+FYYyBKT3zFSsjx+ZTI2yRG2sFOwbBMchtQf5MGUoQfNznR
ANlqUNXdWlMrkso93JburzqBEoNGy8utK0TNnepMbb1yc4YuXk/nMRZaBPA2Lh8u
twUG3vMvNQHsliV48CQ+4CJutM34rvI9AfJeI2CkcxBUlCyYatGcA12nvCr7dGdy
EKeG5G4XyBak48571FtQqNqkSkCQlqmv93LVoOHqzEQKcJWw8zPxZc0dnORZVmgL
l3Ws/QltCsIf6OTyQOfGHi81ehr6P4j1KQ56MfgWcqBqdeIANxVcb0ZVVb3SiEhT
AgMBAAGjggFHMIIBQzASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIB
hjAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwHQYDVR0OBBYEFL2Xnd+h
2BslmeMMBAaJZBLXZSTHMB8GA1UdIwQYMBaAFHwMMh+n2TB/xH1oo2Kooc6rB1sn
MF4GCCsGAQUFBwEBBFIwUDBOBggrBgEFBQcwAoZCaHR0cDovL2NlcnRpZmljYXRl
cy5zdGFyZmllbGR0ZWNoLmNvbS9yZXBvc2l0b3J5L3Nmcm9vdC1nMi5jcnQuY2Vy
MDsGA1UdHwQ0MDIwMKAuoCyGKmh0dHA6Ly9jcmwuc3RhcmZpZWxkdGVjaC5jb20v
c2Zyb290LWcyLmNybDAhBgNVHSAEGjAYMAgGBmeBDAECATAMBgorBgEEAYOGGQEB
MA0GCSqGSIb3DQEBCwUAA4IBAQBosoh/lcTPBVC36SxIqjmdnuKwHs4SUDa/o5+y
AJ22DaZDIFMJS+LLhslCVPAO9lQ5LR0AviC8atueKWOxPUw5aNDodEpIe988xSNa
LSuPXsAB93FJ5v2BxdCiDHlIZbJPAOVQAo+rP2WgaTcDFX6g6LvK1b/RS9kL+rCB
OebvFIbOmhfErkXjR7F6p759ftTQ23tT1qoTgegkySRgugEp0mtveWq87UIsGgdI
e3UVWONiA9l3hTmxRyHkaYLlBzDdVPt4MIUkFrxZAz/8ebh+x2KNfAO6Mxi/vdS0
9NEqn0ekjRmQK5UvHXoBNHVvZ1VrbMv6hlIMCt++bfb6UBoK
-----END CERTIFICATE-----`

async function getAccessToken(refreshToken) {
  const res = await fetch('https://auth.tesla.com/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: TESLA_CLIENT_ID,
      client_secret: TESLA_CLIENT_SECRET,
      refresh_token: refreshToken,
    })
  })
  const data = await res.json()
  if (!data.access_token) { console.error('Token error:', data); return null }
  return data.access_token
}

async function getVehicles(accessToken) {
  const res = await fetch('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const data = await res.json()
  return data.response || []
}

async function registerVehicle(accessToken, vehicleId, vin) {
  const config = {
    hostname: TELEMETRY_HOST,
    port: 443,
    ca: RAILWAY_CA,
    fields: {
      Location:                   { interval_seconds: 5 },
      VehicleSpeed:               { interval_seconds: 5 },
      Heading:                    { interval_seconds: 5 },
      BatteryLevel:               { interval_seconds: 30 },
      ChargingState:              { interval_seconds: 30 },
      Gear:                       { interval_seconds: 1 },
      Odometer:                   { interval_seconds: 10 },
      AutopilotEnabled:           { interval_seconds: 1 },
      AutopilotState:             { interval_seconds: 1 },
      ForwardCollisionWarning:    { interval_seconds: 1 },
      LaneDepartureAvoidance:     { interval_seconds: 1 },
      TurnSignalLeft:             { interval_seconds: 1 },
      TurnSignalRight:            { interval_seconds: 1 },
    },
    alert_types: ['service_status']
  }

  const res = await fetch(
    `https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/${vehicleId}/fleet_telemetry_config`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    }
  )
  const data = await res.json()
  console.log(`${vin} (id=${vehicleId}):`, JSON.stringify(data, null, 2))
  return data
}

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

  const { data: members } = await supabase
    .from('family_members')
    .select('id, name, tesla_refresh_token')
    .not('tesla_refresh_token', 'is', null)

  if (!members?.length) { console.error('No members with Tesla tokens'); return }

  for (const member of members) {
    console.log(`\n── ${member.name} ──`)
    const accessToken = await getAccessToken(member.tesla_refresh_token)
    if (!accessToken) continue

    const vehicles = await getVehicles(accessToken)
    if (!vehicles.length) { console.log('No vehicles found'); continue }

    for (const v of vehicles) {
      console.log(`Registering ${v.vin} (${v.display_name})...`)
      await registerVehicle(accessToken, v.id_s, v.vin)
    }
  }
}

main().catch(console.error)
