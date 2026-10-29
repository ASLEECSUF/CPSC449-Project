import express, { Router } from 'express'
import { isAuthError } from '@supabase/supabase-js'
import config from './config.js'
import { findOwnedItem, findProfile, getUserForToken, signIn, signUp } from './db.js'

const INVALID_TEXT_REPRESENTATION = '22P02'

function isClientAuthError(error) {
	return isAuthError(error) && error.status >= 400 && error.status < 500
}

function readBearerToken(request) {
	const header = request.get('authorization') ?? ''
	const parts = header.split(' ').filter((part) => part !== '')
	if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
		return null
	}
	return parts[1]
}

async function requireAuth(request, response, next) {
	const token = readBearerToken(request)
	if (!token) {
		response.status(401).json({ error: 'Missing bearer token' })
		return
	}

	let user
	try {
		user = await getUserForToken(token)
	} catch (error) {
		if (isClientAuthError(error)) {
			response.status(401).json({ error: 'Invalid or expired token' })
			return
		}
		console.error('Supabase Auth token check failed:', error)
		response.status(502).json({ error: 'Authentication service is unavailable' })
		return
	}

	let profile
	try {
		profile = await findProfile(user.id)
	} catch (error) {
		console.error('Profile lookup failed:', error)
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

function requireAdmin(request, response, next) {
	if (!request.user) {
		response.status(401).json({ error: 'Authentication required' })
		return
	}
	if (request.user.role !== 'admin') {
		response.status(403).json({ error: 'Admin access required' })
		return
	}
	next()
}

async function loadOwnedItem(request, response, next, itemId) {
	if (!request.user) {
		response.status(401).json({ error: 'Authentication required' })
		return
	}

	let item
	try {
		item = await findOwnedItem(request.user.id, itemId)
	} catch (error) {
		if (error?.code !== INVALID_TEXT_REPRESENTATION) {
			console.error('Tracked item lookup failed:', error)
			response.status(502).json({ error: 'Item service is unavailable' })
			return
		}
	}
	if (!item) {
		response.status(404).json({ error: 'Item not found' })
		return
	}

	request.item = item
	next()
}

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
	if (!isClientAuthError(error)) {
		console.error('Supabase Auth request failed:', error)
		response.status(502).json({ error: 'Authentication service is unavailable' })
		return
	}
	const status = error.status === 400 ? invalidRequestStatus : error.status
	response.status(status).json({ error: error.message })
}

function getHealth(_request, response) {
	response.json({ status: 'ok' })
}

async function postSignup(request, response) {
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

async function postLogin(request, response) {
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

const itemRouter = Router()
itemRouter.use(requireAuth)
itemRouter.param('id', loadOwnedItem)

const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)

const app = express()
app.use(express.json())

app.get('/api/health', getHealth)
app.post('/api/auth/signup', postSignup)
app.post('/api/auth/login', postLogin)
app.use('/api/items', itemRouter)
app.use('/api/admin', adminRouter)

const server = app.listen(config.port, () => {
	console.log(`Price Tracker API listening on port ${config.port}`)
})

export { app, server }
