import { isAuthError } from '@supabase/supabase-js'
import { signIn, signUp } from '../services/authService.js'

function readCredentials(body) {
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  return { email, password }
}

function toUser(user) {
  return { id: user.id, email: user.email }
}

function toSessionBody(session) {
  return {
    accessToken: session.access_token,
    expiresAt: session.expires_at,
    user: toUser(session.user),
  }
}

function sendAuthError(response, error, invalidRequestStatus) {
  if (!isAuthError(error) || !(error.status >= 400 && error.status < 500)) {
    console.error('Supabase Auth request failed:', error)
    response.status(502).json({ error: 'Authentication service is unavailable' })
    return
  }
  const status = error.status === 400 ? invalidRequestStatus : error.status
  response.status(status).json({ error: error.message })
}

export async function postSignup(request, response) {
  const { email, password } = readCredentials(request.body)
  if (!email || !password) {
    response.status(400).json({ error: 'email and password are required' })
    return
  }

  let data
  try {
    data = await signUp(email, password)
  } catch (error) {
    sendAuthError(response, error, 400)
    return
  }

  if (data.session) {
    response.status(201).json(toSessionBody(data.session))
    return
  }
  response.status(201).json({ user: toUser(data.user), emailConfirmationRequired: true })
}

export async function postLogin(request, response) {
  const { email, password } = readCredentials(request.body)
  if (!email || !password) {
    response.status(400).json({ error: 'email and password are required' })
    return
  }

  let data
  try {
    data = await signIn(email, password)
  } catch (error) {
    sendAuthError(response, error, 401)
    return
  }

  response.json(toSessionBody(data.session))
}
