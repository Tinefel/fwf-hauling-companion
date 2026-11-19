
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://ltpmorusoslwdyhqpjwe.supabase.co'
const supabasePublishableKey = 'sb_publishable_n9nPdEW9fPcaM8JS7z0sVA_v1ey2sn2'

export const supabase = createClient(
  supabaseUrl,
    supabasePublishableKey
    )
    