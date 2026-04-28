// Run once when Tesla API unblocks: registers flock-chi-lemon.vercel.app as partner domain
// node register-domain.js

const CLIENT_ID     = process.env.TESLA_CLIENT_ID
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET
const DOMAIN        = 'flock-chi-lemon.vercel.app'

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

  const { data: members } = await supabase
    .from('family_members')
    .select('name, tesla_refresh_token')
    .not('tesla_refresh_token', 'is', null)

  if (!members?.length) { console.error('No members with Tesla tokens'); return }

  // Use first member's token to register the domain (only needs to happen once)
  const member = members[0]
  console.log(`Using ${member.name}'s token to register domain...`)

  const tokenRes = await fetch('https://auth.tesla.com/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: member.tesla_refresh_token,
    })
  })
  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) { console.error('Token error:', tokenData); return }

  const res = await fetch('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ domain: DOMAIN })
  })
  const data = await res.json()
  console.log('Domain registration result:', JSON.stringify(data, null, 2))

  if (data.response || res.ok) {
    console.log(`\n✅ Domain registered! Now each family member should visit:`)
    console.log(`   https://tesla.com/_ak/${DOMAIN}`)
    console.log(`\nThen run: node register-vehicle.js`)
  }
}

main().catch(console.error)
