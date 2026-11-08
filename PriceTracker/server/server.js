import express, { Router } from 'express'
import { isAuthError } from '@supabase/supabase-js'
import {
	convertPrice,
	getEbayItem,
	getSupportedCurrencies,
	parseAmazonUrl,
	parseEbayItem,
	scrapeAmazonProduct,
} from './apis.js'
import config from './config.js'
import {
	deleteOwnedItem,
	findOwnedItem,
	findOwnedItemByVendorId,
	findProfile,
	getUserForToken,
	insertPriceHistory,
	insertTrackedItem,
	isVendorEnabled,
	listOwnedItems,
	listOwnedPriceHistory,
	signIn,
	signUp,
	updateOwnedTargetPrice,
	updatePreferredCurrency,
} from './db.js'

const INVALID_TEXT_REPRESENTATION = '22P02'
const UNIQUE_VIOLATION = '23505'
const MAX_STORED_PRICE = 10_000_000_000
const VENDOR_LABELS = {
	amazon: 'Amazon',
	ebay: 'eBay',
}

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

function toProfileBody(user) {
	return {
		id: user.id,
		email: user.email,
		role: user.role,
		preferredCurrency: user.preferredCurrency,
	}
}

function readCurrencyInput(body) {
	if (typeof body?.preferredCurrency !== 'string') {
		return ''
	}
	return body.preferredCurrency.trim().toUpperCase()
}

function isListedCurrency(currencies, code) {
	for (const currency of currencies) {
		if (currency.code === code) {
			return true
		}
	}
	return false
}

function getProfile(request, response) {
	response.json(toProfileBody(request.user))
}

async function patchProfile(request, response) {
	const code = readCurrencyInput(request.body)
	if (!code) {
		response.status(400).json({ error: 'preferredCurrency is required' })
		return
	}

	const supported = await getSupportedCurrencies()
	if (!supported.currencies) {
		response.status(503).json({ error: 'Currency service is unavailable' })
		return
	}
	if (!isListedCurrency(supported.currencies, code)) {
		response.status(400).json({ error: `Unsupported currency: ${code}` })
		return
	}

	let profile
	try {
		profile = await updatePreferredCurrency(request.user.id, code)
	} catch (error) {
		console.error('Profile update failed:', error)
		response.status(502).json({ error: 'Profile service is unavailable' })
		return
	}

	request.user.preferredCurrency = profile.preferred_currency
	response.json(toProfileBody(request.user))
}

async function getCurrencies(_request, response) {
	const supported = await getSupportedCurrencies()
	if (!supported.currencies) {
		response.status(503).json({ error: 'Currency service is unavailable' })
		return
	}
	response.json({ currencies: supported.currencies, stale: supported.stale })
}

async function toItemBody(item, displayCurrency) {
	const current = await convertPrice(item.current_price, item.currency, displayCurrency)
	const target = await convertPrice(item.target_price, item.currency, displayCurrency)
	return {
		id: item.id,
		vendor: item.vendor,
		vendorItemId: item.vendor_item_id,
		url: item.url,
		name: item.name,
		currency: item.currency,
		currentPrice: current.price,
		targetPrice: target.price,
		displayCurrency: current.displayCurrency,
		displayCurrentPrice: current.displayPrice,
		displayTargetPrice: target.displayPrice,
		rate: current.rate,
		rateDate: current.rateDate,
		rateStale: current.rateStale,
		converted: current.converted,
		createdAt: item.created_at,
	}
}

async function toHistoryPoint(entry, displayCurrency) {
	const conversion = await convertPrice(entry.price, entry.currency, displayCurrency)
	return {
		id: entry.id,
		recordedAt: entry.recorded_at,
		price: conversion.price,
		currency: conversion.currency,
		displayPrice: conversion.displayPrice,
		displayCurrency: conversion.displayCurrency,
	}
}

function readItemInput(body) {
	if (typeof body?.input !== 'string') {
		return ''
	}
	return body.input.trim()
}

function detectVendorItem(input) {
	const amazon = parseAmazonUrl(input)
	if (amazon) {
		return { vendor: 'amazon', vendorItemId: amazon.asin, url: amazon.url }
	}
	const ebay = parseEbayItem(input)
	if (ebay) {
		return { vendor: 'ebay', vendorItemId: ebay.itemId, url: ebay.url }
	}
	return null
}

function isVendorConfigured(vendor) {
	if (vendor === 'amazon') {
		return config.brightData.enabled
	}
	return config.ebay.enabled
}

async function fetchVendorProduct(vendorItem) {
	if (vendorItem.vendor === 'amazon') {
		return scrapeAmazonProduct(vendorItem.url)
	}
	return getEbayItem(vendorItem.vendorItemId)
}

function isValidPriceInput(value) {
	if (value === null) {
		return true
	}
	return Number.isFinite(value) && value >= 0
}

async function listItems(request, response) {
	let items
	try {
		items = await listOwnedItems(request.user.id)
	} catch (error) {
		console.error('Tracked item list failed:', error)
		response.status(502).json({ error: 'Item service is unavailable' })
		return
	}

	const bodies = []
	for (const item of items) {
		bodies.push(await toItemBody(item, request.user.preferredCurrency))
	}
	response.json({ items: bodies })
}

async function addItem(request, response) {
	const input = readItemInput(request.body)
	const vendorItem = detectVendorItem(input)
	if (!vendorItem) {
		response.status(400).json({ error: 'input must be an Amazon product URL or an eBay item ID or link' })
		return
	}
	const label = VENDOR_LABELS[vendorItem.vendor]
	if (!isVendorConfigured(vendorItem.vendor)) {
		response.status(503).json({ error: `${label} tracking is not configured` })
		return
	}

	let vendorEnabled
	let existing
	try {
		vendorEnabled = await isVendorEnabled(vendorItem.vendor)
		existing = await findOwnedItemByVendorId(request.user.id, vendorItem.vendor, vendorItem.vendorItemId)
	} catch (error) {
		console.error('Tracked item check failed:', error)
		response.status(502).json({ error: 'Item service is unavailable' })
		return
	}
	if (!vendorEnabled) {
		response.status(503).json({ error: `${label} tracking is disabled` })
		return
	}
	if (existing) {
		response.status(409).json({ error: 'You are already tracking this item' })
		return
	}

	let product
	try {
		product = await fetchVendorProduct(vendorItem)
	} catch (error) {
		console.error(`${label} lookup failed:`, error)
		response.status(502).json({ error: `${label} lookup failed` })
		return
	}
	if (!product) {
		response.status(422).json({ error: `Could not read a current price for this ${label} item` })
		return
	}

	let item
	try {
		item = await insertTrackedItem(request.user.id, {
			vendor: vendorItem.vendor,
			vendorItemId: vendorItem.vendorItemId,
			url: vendorItem.url,
			name: product.name,
			price: product.price,
			currency: product.currency,
		})
	} catch (error) {
		if (error?.code === UNIQUE_VIOLATION) {
			response.status(409).json({ error: 'You are already tracking this item' })
			return
		}
		console.error('Tracked item insert failed:', error)
		response.status(502).json({ error: 'Item service is unavailable' })
		return
	}

	try {
		await insertPriceHistory(item.id, item.current_price, item.currency)
	} catch (error) {
		console.error('First price history entry failed:', error)
	}

	response.status(201).json(await toItemBody(item, request.user.preferredCurrency))
}

async function patchItem(request, response) {
	const targetPrice = request.body?.targetPrice
	if (targetPrice === undefined || !isValidPriceInput(targetPrice)) {
		response.status(400).json({ error: 'targetPrice must be a non-negative number or null' })
		return
	}

	let nativeTarget = null
	if (targetPrice !== null) {
		const conversion = await convertPrice(targetPrice, request.user.preferredCurrency, request.item.currency)
		if (!conversion.converted) {
			response.status(503).json({ error: 'Exchange rates are unavailable, so the target price was not saved' })
			return
		}
		nativeTarget = conversion.displayPrice
	}
	if (nativeTarget !== null && nativeTarget >= MAX_STORED_PRICE) {
		response.status(400).json({ error: 'targetPrice is too large' })
		return
	}

	let item
	try {
		item = await updateOwnedTargetPrice(request.user.id, request.item.id, nativeTarget)
	} catch (error) {
		console.error('Target price update failed:', error)
		response.status(502).json({ error: 'Item service is unavailable' })
		return
	}

	response.json(await toItemBody(item, request.user.preferredCurrency))
}

async function deleteItem(request, response) {
	try {
		await deleteOwnedItem(request.user.id, request.item.id)
	} catch (error) {
		console.error('Tracked item delete failed:', error)
		response.status(502).json({ error: 'Item service is unavailable' })
		return
	}
	response.status(204).end()
}

async function getItemHistory(request, response) {
	let entries
	try {
		entries = await listOwnedPriceHistory(request.user.id, request.item.id)
	} catch (error) {
		console.error('Price history lookup failed:', error)
		response.status(502).json({ error: 'Price history service is unavailable' })
		return
	}

	const displayCurrency = request.user.preferredCurrency
	const points = []
	for (const entry of entries) {
		points.push(await toHistoryPoint(entry, displayCurrency))
	}
	response.json({
		item: await toItemBody(request.item, displayCurrency),
		points,
	})
}

const itemRouter = Router()
itemRouter.use(requireAuth)
itemRouter.param('id', loadOwnedItem)
itemRouter.get('/', listItems)
itemRouter.post('/', addItem)
itemRouter.patch('/:id', patchItem)
itemRouter.delete('/:id', deleteItem)
itemRouter.get('/:id/history', getItemHistory)

const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)

const app = express()
app.use(express.json())

app.get('/api/health', getHealth)
app.post('/api/auth/signup', postSignup)
app.post('/api/auth/login', postLogin)
app.get('/api/profile', requireAuth, getProfile)
app.patch('/api/profile', requireAuth, patchProfile)
app.get('/api/currencies', requireAuth, getCurrencies)
app.use('/api/items', itemRouter)
app.use('/api/admin', adminRouter)

const server = app.listen(config.port, () => {
	console.log(`Price Tracker API listening on port ${config.port}`)
})

export { app, server }
