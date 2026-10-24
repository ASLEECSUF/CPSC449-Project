import { createAuthClient } from '../db/supabase.js'

export async function signUp(email, password) {
  const { data, error } = await createAuthClient().auth.signUp({ email, password })
  if (error) {
    throw error
  }
  return data
}

export async function signIn(email, password) {
  const { data, error } = await createAuthClient().auth.signInWithPassword({ email, password })
  if (error) {
    throw error
  }
  return data
}
