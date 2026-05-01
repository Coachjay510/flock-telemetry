// Register Fleet Telemetry config per-vehicle via Tesla Fleet API
// node register-vehicle.js

const TESLA_CLIENT_ID     = process.env.TESLA_CLIENT_ID
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET

// TCP proxy address from Railway dashboard (Settings → Networking → TCP Proxy)
// Format: "hostname:port"  e.g. "monorail.proxy.rlwy.net:12345"
const TELEMETRY_HOST = process.env.TELEMETRY_HOST || 'REPLACE_WITH_TCP_PROXY_HOST'
const TELEMETRY_PORT = parseInt(process.env.TELEMETRY_PORT || '0', 10)

// Flock self-signed CA cert (fleet-telemetry server cert is signed by this CA)
const RAILWAY_CA = `-----BEGIN CERTIFICATE-----
MIIE8DCCAtgCCQDZ0nOO698EJTANBgkqhkiG9w0BAQsFADA6MRswGQYDVQQDDBJG
bG9jayBUZWxlbWV0cnkgQ0ExDjAMBgNVBAoMBUZsb2NrMQswCQYDVQQGEwJVUzAe
Fw0yNjA1MDExOTI2MzZaFw0zNjA0MjgxOTI2MzZaMDoxGzAZBgNVBAMMEkZsb2Nr
IFRlbGVtZXRyeSBDQTEOMAwGA1UECgwFRmxvY2sxCzAJBgNVBAYTAlVTMIICIjAN
BgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAzyqGO77yAKg4vXGCzy2g+XRERp5d
XJ7RopjPJ+YeUOnqsdul8AHaR6L7V7f9EgIypCv+nk3yzrkZgvcfIDESMq6kblAZ
ZkQVNvSO3Nga4Ae26Vdo0fv0+NRdCj0slssWSRATduLUMZfKcGP1r4Pa4vgkjS4u
DBaaP92Zz3uEm5Bt1PGLsPppSyXvLeJrVFn/9DsTXuOhecCLo3ScQcK+gu7sdNmK
g937iMMqM72m4hXciPyCRag4zp8fn+tg+Stbl7n9hIIJzfvBYkJdKDsgK3YJeQA9
Rt2sVT3SuSSq/DyFsYjT6sOkZ7i6VFm7eChxAOHSdZ5XdVIqcEmAEPUA1ld4YxiK
JcaJC59DQ7bJj36z147BEevK1k+qTqo9vyOTm4za1/5chxxr0zwmajzh+1iGZq6g
T4wrmGc0NgkAnVP6kILo4sOzNoOgFGPmnV64ubEn98x96/PsGypJ0aeJr2HKfcJu
2w+oX2+CQzSgsqA03Nz6gubaRvtG1WPlhptXzdGksILKaVvb/SExvaUXm9p8xun+
/bhBqdxVQOtjJNOuhvMKeqYu7UiGSajEd7astL1yXXEyWDKUQ32tAl9lRJ8QotNI
xLQL2Jo/GMNJRjt1vmhY8/uBKMywmz+nRzq19C9eF656n1IVAWTHDKGKkKBAC0pe
zwTlKBC8uoDZ5+8CAwEAATANBgkqhkiG9w0BAQsFAAOCAgEAGpCNblHkpwApFl0m
nxly8tUh+ZgF5xJbXtuiq1oYtz97tvQe44xT3lF28eXoD60NI1nFXkld6C/WqVnE
BqDVXQ851qtzB4ozcKN5J1QYRuIiPuNbsCFjntQBMviKahtKhri9PkSdsrttD7kD
pFp8hJ+M/+ax+G1Q0083H1mwlyef67ifF+vGKh/D5j/T+PiHLgI4O7/mhUsOBy2D
WySWzEuBxSxeR4/tWfECW5LIBiCgaLXEB+hdi6lEcWRNF5f1Z/GSWYpHg9lpRFxh
k0T0NHeIuULhFxag/0IVs5LNeC4vIY/HJWnhGyxbv2dYzDWDlCvQK0KiMs9mqxp8
q/R+52ybhb//VU7a5rDrh14lHi2H4A+E/KN6wEXhKGetGT33np7A9eUPBBDK7IOY
YFefovbTjo4AzcQcOqsLg5kf2ITE0gQv3Q2AHbdg4OEbMgcmpWFQsuFjBDyi1Npm
SkvF/bQNB9Jp6f+hiqbRaygq/adsmLpb/TfklziLe9GophQt6IPHfF/XkLBg5ruP
cCLnf6pqM+59Xx5q+iAWF23oaEsO9sPGR7fy1h7PPyZR3918dkjzZI/1aiUD5ii6
4WBwTMZwa3eVWOHq4CDVN+XGZilFioKEX8B+HV2yX1htCKKERvkyTkj3RReL4ogM
fy5EAhZJLL6gHNvhCLDFA6FFnKM=
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
    port: TELEMETRY_PORT || 443,
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
