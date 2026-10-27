import { isAuthError } from '@supabase/supabase-js'
import { supabaseAdmin } from '../db/supabase.js'

function readBearerToken(request) {
	const header = request.get('authorization') ?? ''
	const match = /^Bearer\s+(\S+)$/i.exec(header)
	return match ? match[1] : null
}

export async function requireAuth(request, response, next) {
	const token = readBearerToken(request)
	if (!token) {
		response.status(401).json({ error: 'Missing bearer token' })
		return
	}

	const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token)
	if (userError) {
		if (isAuthError(userError) && userError.status >= 400 && userError.status < 500) {
			response.status(401).json({ error: 'Invalid or expired token' })
			return
		}
		console.error('Supabase Auth token check failed:', userError)
		response.status(502).json({ error: 'Authentication service is unavailable' })
		return
	}

	const { user } = userData
	const { data: profile, error: profileError } = await supabaseAdmin
		.from('profiles')
		.select('role, disabled, preferred_currency')
		.eq('id', user.id)
		.maybeSingle()
	if (profileError) {
		console.error('Profile lookup failed:', profileError)
		response.status(502).json({ error: 'Profile service is unavailable' })
		return
	}
	if (!profile) {
		response.status(401).json({ error: 'Profile not found' })
		return
	}
	if (profile.disabled) {
		response.status(403).json({ error: 'Account disabled' })
		return
	}

	request.user = {
		id: user.id,
		email: user.email,
		role: profile.role,
		preferredCurrency: profile.preferred_currency,
	}
	next()
}
