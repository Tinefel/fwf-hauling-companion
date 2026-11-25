
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://ltpmorusoslwdyhqpjwe.supabase.co'
const supabasePublishableKey = 'sb_publishable_n9nPdEW9fPcaM8JS7z0sVA_v1ey2sn2'

export const supabase = createClient(
  supabaseUrl,
    supabasePublishableKey
    )

export const RECEIPTS_BUCKET = 'expense-receipts'

let anonymousSignInPromise: Promise<void> | null = null

export const ensureAnonymousSession = async () => {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (data.session) return

  if (!anonymousSignInPromise) {
    anonymousSignInPromise = supabase.auth.signInAnonymously()
      .then(({ error: signInError }) => {
        if (signInError) throw signInError
      })
      .finally(() => {
        anonymousSignInPromise = null
      })
  }
  await anonymousSignInPromise
}
    