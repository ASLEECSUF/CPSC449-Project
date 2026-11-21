import { setTimeout as sleep } from 'node:timers/promises'
import config from './config.js'
import { recordApiUsage } from './db.js'

const BRIGHTDATA_BASE_URL = 'https://api.brightdata.com/datasets/v3'
const BRIGHTDATA_REQUEST_TIMEOUT_MS = 90_000
const BRIGHTDATA_SNAPSHOT_WAIT_MS = 120_000
const BRIGHTDATA_SNAPSHOT_POLL_MS = 10_000
const AMAZON_BATCH_SIZE = 20
const EBAY_API_HOSTS = {
	production: 'https://api.ebay.com',
	sandbox: 'https://api.sandbox.ebay.com',
}
const EBAY_OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope'
const EBAY_REQUEST_TIMEOUT_MS = 15_000
const EBAY_TOKEN_REFRESH_MARGIN_MS = 300_000
const EBAY_SEARCH_LIMIT = 20
const EBAY_MAX_SEARCH_LIMIT = 50
const EBAY_MAX_ITEM_ID_LENGTH = 19
const FRANKFURTER_REQUEST_TIMEOUT_MS = 15_000
const FRANKFURTER_CACHE_MS = 21_600_000
const FRANKFURTER_RETRY_MS = 300_000
const EBAY_MARKETPLACE_CURRENCIES = {
	EBAY_US: 'USD',
	EBAY_CA: 'CAD',
	EBAY_GB: 'GBP',
	EBAY_AU: 'AUD',
	EBAY_DE: 'EUR',
	EBAY_FR: 'EUR',
	EBAY_IT: 'EUR',
	EBAY_ES: 'EUR',
}
const NRP_REQUEST_TIMEOUT_MS = 30_000
const NRP_MAX_REPLY_TOKENS = 200
const MAX_SEARCH_KEYWORDS_LENGTH = 100
const SEARCH_CONDITIONS = ['new', 'used']
const SEARCH_PROMPT = [
	'You turn a shopping request into search settings for eBay.',
	'Reply with only one JSON object and no other text, in this shape:',
	'{"keywords": string, "minPrice": number or null, "maxPrice": number or null, "condition": "new" or "used" or null}',
	'keywords: the product words to search for, without prices, condition, or filler words.',
	'minPrice and maxPrice: plain numbers taken from the request, without currency symbols. Use null when the request gives no limit.',
	'condition: "new" or "used" only when the request asks for one, otherwise null.',
].join('\n')
const UPPERCASE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'

let ebayToken = ''
let ebayTokenExpiresAt = 0
let ebayTokenRequest = null
const currencyCache = createCacheEntry()
const rateCaches = new Map()

function isUppercaseLetter(character) {
	return UPPERCASE_LETTERS.includes(character)
}

function isDigit(character) {
	return DIGITS.includes(character)
}

function isAsin(value) {
	if (value.length !== 10) {
		return false
	}
	for (const character of value) {
		if (!isUppercaseLetter(character) && !isDigit(character)) {
			return false
		}
	}
	return true
}

function isCurrencyCode(value) {
	if (value.length !== 3) {
		return false
	}
	for (const character of value) {
		if (!isUppercaseLetter(character)) {
			return false
		}
	}
	return true
}

function canonicalAmazonUrl(asin) {
	return `https://www.amazon.com/dp/${asin}`
}

function toUrl(text) {
	let fullText = text
	if (!text.includes('://')) {
		fullText = `https://${text}`
	}
	try {
		return new URL(fullText)
	} catch {
		return null
	}
}

function isAmazonHost(hostname) {
	const host = hostname.toLowerCase()
	return host === 'amazon.com' || host.endsWith('.amazon.com')
}

function findAsinInPath(pathname) {
	const segments = pathname.split('/').filter((segment) => segment !== '')
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i].toLowerCase()
		let previous = ''
		if (i > 0) {
			previous = segments[i - 1].toLowerCase()
		}
		const isDpMarker = segment === 'dp'
		const isGpProductMarker = segment === 'product' && previous === 'gp'
		if (isDpMarker || isGpProductMarker) {
			return segments[i + 1].toUpperCase()
		}
	}
	return ''
}

export function parseAmazonUrl(input) {
	if (typeof input !== 'string') {
		return null
	}
	const url = toUrl(input.trim())
	if (!url) {
		return null
	}
	const isWebUrl = url.protocol === 'http:' || url.protocol === 'https:'
	if (!isWebUrl || !isAmazonHost(url.hostname)) {
		return null
	}
	const asin = findAsinInPath(url.pathname)
	if (!isAsin(asin)) {
		return null
	}
	return { asin, url: canonicalAmazonUrl(asin) }
}

function readText(value) {
	if (typeof value !== 'string') {
		return ''
	}
	return value.trim()
}

function readAsin(value) {
	const asin = readText(value).toUpperCase()
	if (!isAsin(asin)) {
		return null
	}
	return asin
}

function readPrice(value) {
	const isNumber = typeof value === 'number' && Number.isFinite(value)
	if (!isNumber || value < 0) {
		return null
	}
	return value
}

function readRecordAsin(record) {
	const inputAsin = readAsin(record.input_asin)
	if (inputAsin) {
		return inputAsin
	}
	const asin = readAsin(record.asin)
	if (asin) {
		return asin
	}
	let inputUrl = record.url
	if (record.input) {
		inputUrl = record.input.url
	}
	const parsed = parseAmazonUrl(inputUrl)
	if (!parsed) {
		return null
	}
	return parsed.asin
}

function readBuyBoxPrice(record) {
	const optionType = readText(record.buying_option_type).toUpperCase()
	if (optionType !== '' && optionType !== 'NEW') {
		return null
	}
	const finalPrice = readPrice(record.final_price)
	if (finalPrice !== null) {
		return finalPrice
	}
	return readPrice(record.price)
}

function isNewCondition(condition) {
	return readText(condition).toLowerCase() === 'new'
}

function readNewOfferPrices(record) {
	const prices = []
	if (!Array.isArray(record.other_sellers_prices)) {
		return prices
	}
	for (const offer of record.other_sellers_prices) {
		if (!offer || !isNewCondition(offer.condition)) {
			continue
		}
		const price = readPrice(offer.price)
		if (price !== null) {
			prices.push(price)
		}
	}
	return prices
}

function readCheapestNewPrice(record) {
	let cheapest = readBuyBoxPrice(record)
	for (const price of readNewOfferPrices(record)) {
		if (cheapest === null || price < cheapest) {
			cheapest = price
		}
	}
	return cheapest
}

function toAmazonProduct(record) {
	if (!record || typeof record !== 'object') {
		return null
	}
	if (record.error || record.error_code) {
		return null
	}
	const asin = readRecordAsin(record)
	const price = readCheapestNewPrice(record)
	const currency = readText(record.currency).toUpperCase()
	const name = readText(record.title)
	if (!asin || price === null || !isCurrencyCode(currency) || !name) {
		return null
	}
	let availability = null
	if (typeof record.availability === 'string') {
		availability = record.availability
	}
	return {
		asin,
		url: canonicalAmazonUrl(asin),
		name,
		price,
		currency,
		availability,
	}
}

async function brightDataRequest(operation, path, method = 'GET', body = undefined) {
	let response
	try {
		response = await fetch(`${BRIGHTDATA_BASE_URL}${path}`, {
			method,
			body,
			headers: {
				Authorization: `Bearer ${config.brightData.apiKey}`,
				'Content-Type': 'application/json',
			},
			signal: AbortSignal.timeout(BRIGHTDATA_REQUEST_TIMEOUT_MS),
		})
	} catch (error) {
		await recordApiUsage('brightdata', operation, false)
		throw new Error(`Bright Data ${operation} request failed`, { cause: error })
	}

	await recordApiUsage('brightdata', operation, response.ok)
	if (!response.ok) {
		throw new Error(`Bright Data ${operation} request failed with status ${response.status}`)
	}
	const data = await response.json()
	return { status: response.status, data }
}

async function waitForSnapshot(snapshotId) {
	if (typeof snapshotId !== 'string' || snapshotId === '') {
		throw new Error('Bright Data did not return a snapshot ID')
	}
	const id = encodeURIComponent(snapshotId)
	const deadline = Date.now() + BRIGHTDATA_SNAPSHOT_WAIT_MS
	while (Date.now() < deadline) {
		await sleep(BRIGHTDATA_SNAPSHOT_POLL_MS)
		const progress = await brightDataRequest('progress', `/progress/${id}`)
		const status = progress.data ? progress.data.status : null
		if (status === 'ready') {
			const snapshot = await brightDataRequest('snapshot', `/snapshot/${id}?format=json`)
			return snapshot.data
		}
		if (status === 'failed' || status === 'canceled') {
			throw new Error(`Bright Data snapshot ${snapshotId} ${status}`)
		}
	}
	throw new Error(`Bright Data snapshot ${snapshotId} was not ready in time`)
}

async function scrapeAmazonBatch(urls) {
	if (!config.brightData.enabled) {
		throw new Error('Amazon features are disabled')
	}
	const query = new URLSearchParams({ dataset_id: config.brightData.amazonDatasetId, format: 'json' })
	const inputs = urls.map((url) => ({ url }))
	const scrape = await brightDataRequest('scrape', `/scrape?${query}`, 'POST', JSON.stringify(inputs))

	let records = scrape.data
	if (scrape.status === 202) {
		const snapshotId = scrape.data ? scrape.data.snapshot_id : null
		records = await waitForSnapshot(snapshotId)
	}
	if (!Array.isArray(records)) {
		records = [records]
	}

	const requestedAsins = urls.map((url) => parseAmazonUrl(url).asin)
	const products = []
	for (const record of records) {
		const product = toAmazonProduct(record)
		if (!product || !requestedAsins.includes(product.asin)) {
			console.warn('Skipping invalid Bright Data record:', record)
			continue
		}
		const alreadyAdded = products.some((existing) => existing.asin === product.asin)
		if (!alreadyAdded) {
			products.push(product)
		}
	}
	return products
}

export async function scrapeAmazonProduct(url) {
	const parsed = parseAmazonUrl(url)
	if (!parsed) {
		throw new Error('Not a valid Amazon product URL')
	}
	const products = await scrapeAmazonBatch([parsed.url])
	if (products.length === 0) {
		return null
	}
	return products[0]
}

export async function scrapeAmazonProducts(urls) {
	const canonicalUrls = []
	for (const url of urls) {
		const parsed = parseAmazonUrl(url)
		if (parsed && !canonicalUrls.includes(parsed.url)) {
			canonicalUrls.push(parsed.url)
		}
	}

	let products = []
	for (let start = 0; start < canonicalUrls.length; start += AMAZON_BATCH_SIZE) {
		const batch = canonicalUrls.slice(start, start + AMAZON_BATCH_SIZE)
		try {
			const batchProducts = await scrapeAmazonBatch(batch)
			products = products.concat(batchProducts)
		} catch (error) {
			console.error(`Bright Data batch of ${batch.length} Amazon URLs failed:`, error)
		}
	}
	return products
}

function isDigits(value) {
	if (value === '') {
		return false
	}
	for (const character of value) {
		if (!isDigit(character)) {
			return false
		}
	}
	return true
}

function isDecimalText(text) {
	const parts = text.split('.')
	if (parts.length > 2) {
		return false
	}
	if (!isDigits(parts[0])) {
		return false
	}
	if (parts.length === 2 && !isDigits(parts[1])) {
		return false
	}
	return true
}

function isLegacyItemId(value) {
	return value.length <= EBAY_MAX_ITEM_ID_LENGTH && isDigits(value)
}

function canonicalEbayUrl(legacyItemId, variationId) {
	const url = `https://www.ebay.com/itm/${legacyItemId}`
	if (variationId === '0') {
		return url
	}
	return `${url}?var=${variationId}`
}

function toEbayItemRef(legacyItemId, variationId) {
	return {
		itemId: `v1|${legacyItemId}|${variationId}`,
		legacyItemId,
		variationId,
		url: canonicalEbayUrl(legacyItemId, variationId),
	}
}

function readRestfulItemId(text) {
	const parts = text.split('|')
	if (parts.length !== 3 || parts[0] !== 'v1') {
		return null
	}
	if (!isLegacyItemId(parts[1]) || !isDigits(parts[2])) {
		return null
	}
	return toEbayItemRef(parts[1], parts[2])
}

function isEbayHost(hostname) {
	const host = hostname.toLowerCase()
	return host === 'ebay.com' || host.endsWith('.ebay.com')
}

function findLegacyItemIdInPath(pathname) {
	let afterItmMarker = false
	let legacyItemId = ''
	for (const segment of pathname.split('/')) {
		if (afterItmMarker && isLegacyItemId(segment)) {
			legacyItemId = segment
		}
		if (segment.toLowerCase() === 'itm') {
			afterItmMarker = true
		}
	}
	return legacyItemId
}

function readVariationId(url) {
	const variationId = url.searchParams.get('var')
	if (variationId && isDigits(variationId)) {
		return variationId
	}
	return '0'
}

function parseEbayUrl(text) {
	const url = toUrl(text)
	if (!url) {
		return null
	}
	const isWebUrl = url.protocol === 'http:' || url.protocol === 'https:'
	if (!isWebUrl || !isEbayHost(url.hostname)) {
		return null
	}
	const legacyItemId = findLegacyItemIdInPath(url.pathname)
	if (!legacyItemId) {
		return null
	}
	return toEbayItemRef(legacyItemId, readVariationId(url))
}

export function parseEbayItem(input) {
	if (typeof input !== 'string') {
		return null
	}
	const text = input.trim()
	if (isLegacyItemId(text)) {
		return toEbayItemRef(text, '0')
	}
	if (text.startsWith('v1|')) {
		return readRestfulItemId(text)
	}
	return parseEbayUrl(text)
}

function readOptionalText(value) {
	const text = readText(value)
	if (text === '') {
		return null
	}
	return text
}

function readEbayAmount(price) {
	const text = readText(price.value)
	if (!isDecimalText(text)) {
		return null
	}
	return Number(text)
}

function readEbayAvailability(record) {
	if (!Array.isArray(record.estimatedAvailabilities)) {
		return null
	}
	for (const entry of record.estimatedAvailabilities) {
		if (entry && readText(entry.estimatedAvailabilityStatus)) {
			return readText(entry.estimatedAvailabilityStatus)
		}
	}
	return null
}

function readEbayImageUrl(record) {
	if (!record.image) {
		return null
	}
	return readOptionalText(record.image.imageUrl)
}

function toEbayItem(record) {
	if (!record || typeof record !== 'object' || !record.price) {
		return null
	}
	const ref = readRestfulItemId(readText(record.itemId))
	const price = readEbayAmount(record.price)
	const currency = readText(record.price.currency).toUpperCase()
	const name = readText(record.title)
	if (!ref || price === null || !isCurrencyCode(currency) || !name) {
		return null
	}
	return {
		itemId: ref.itemId,
		legacyItemId: ref.legacyItemId,
		url: ref.url,
		name,
		price,
		currency,
		condition: readOptionalText(record.condition),
		imageUrl: readEbayImageUrl(record),
		availability: readEbayAvailability(record),
	}
}

function ebayApiUrl(path) {
	return `${EBAY_API_HOSTS[config.ebay.environment]}${path}`
}

function ebayBasicCredentials() {
	const credentials = `${config.ebay.clientId}:${config.ebay.clientSecret}`
	return Buffer.from(credentials).toString('base64')
}

async function requestEbayToken() {
	const body = new URLSearchParams({ grant_type: 'client_credentials', scope: EBAY_OAUTH_SCOPE })
	let response
	try {
		response = await fetch(ebayApiUrl('/identity/v1/oauth2/token'), {
			method: 'POST',
			body,
			headers: {
				Authorization: `Basic ${ebayBasicCredentials()}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
		})
	} catch (error) {
		await recordApiUsage('ebay', 'token', false)
		throw new Error('eBay token request failed', { cause: error })
	}

	await recordApiUsage('ebay', 'token', response.ok)
	if (!response.ok) {
		throw new Error(`eBay token request failed with status ${response.status}`)
	}
	const data = await response.json()
	const token = readText(data.access_token)
	const lifetimeSeconds = data.expires_in
	if (!token || typeof lifetimeSeconds !== 'number') {
		throw new Error('eBay token response was invalid')
	}
	ebayToken = token
	ebayTokenExpiresAt = Date.now() + lifetimeSeconds * 1000 - EBAY_TOKEN_REFRESH_MARGIN_MS
	return token
}

function hasFreshEbayToken() {
	return ebayToken !== '' && Date.now() < ebayTokenExpiresAt
}

async function getEbayToken() {
	if (hasFreshEbayToken()) {
		return ebayToken
	}
	if (!ebayTokenRequest) {
		ebayTokenRequest = requestEbayToken()
	}
	try {
		return await ebayTokenRequest
	} finally {
		ebayTokenRequest = null
	}
}

async function ebayRequest(operation, path) {
	if (!config.ebay.enabled) {
		throw new Error('eBay features are disabled')
	}
	const token = await getEbayToken()
	let response
	try {
		response = await fetch(ebayApiUrl(path), {
			headers: {
				Authorization: `Bearer ${token}`,
				'X-EBAY-C-MARKETPLACE-ID': config.ebay.marketplaceId,
			},
			signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
		})
	} catch (error) {
		await recordApiUsage('ebay', operation, false)
		throw new Error(`eBay ${operation} request failed`, { cause: error })
	}

	await recordApiUsage('ebay', operation, response.ok)
	if (!response.ok) {
		const error = new Error(`eBay ${operation} request failed with status ${response.status}`)
		error.status = response.status
		throw error
	}
	return response.json()
}

function isMissingItemError(error) {
	return error.status === 400 || error.status === 404
}

function readItemGroupItems(data) {
	const items = []
	if (!data || !Array.isArray(data.items)) {
		return items
	}
	for (const record of data.items) {
		const item = toEbayItem(record)
		if (!item) {
			console.warn('Skipping invalid eBay item group record:', record)
			continue
		}
		items.push(item)
	}
	return items
}

function findCheapestItem(items) {
	let cheapest = null
	for (const item of items) {
		if (cheapest === null || item.price < cheapest.price) {
			cheapest = item
		}
	}
	return cheapest
}

async function getCheapestGroupItem(legacyItemId) {
	const params = new URLSearchParams({ item_group_id: legacyItemId })
	let data
	try {
		data = await ebayRequest('item_group', `/buy/browse/v1/item/get_items_by_item_group?${params}`)
	} catch (error) {
		if (isMissingItemError(error)) {
			return null
		}
		throw error
	}
	return findCheapestItem(readItemGroupItems(data))
}

export async function getEbayItem(input) {
	const parsed = parseEbayItem(input)
	if (!parsed) {
		throw new Error('Not a valid eBay item ID or link')
	}
	let record
	try {
		record = await ebayRequest('item', `/buy/browse/v1/item/${encodeURIComponent(parsed.itemId)}`)
	} catch (error) {
		if (!isMissingItemError(error)) {
			throw error
		}
		if (parsed.variationId !== '0') {
			return null
		}
		return getCheapestGroupItem(parsed.legacyItemId)
	}
	const item = toEbayItem(record)
	if (!item) {
		console.warn('Skipping invalid eBay item record:', record)
	}
	return item
}

function readSearchLimit(limit) {
	if (!Number.isInteger(limit) || limit < 1) {
		return EBAY_SEARCH_LIMIT
	}
	if (limit > EBAY_MAX_SEARCH_LIMIT) {
		return EBAY_MAX_SEARCH_LIMIT
	}
	return limit
}

export function getEbaySearchCurrency() {
	const currency = EBAY_MARKETPLACE_CURRENCIES[config.ebay.marketplaceId]
	if (!currency) {
		return null
	}
	return currency
}

function formatFilterPrice(price) {
	if (price === null) {
		return ''
	}
	return String(price)
}

function buildPriceFilter(minPrice, maxPrice) {
	const low = formatFilterPrice(minPrice)
	const high = formatFilterPrice(maxPrice)
	if (high === '') {
		return `price:[${low}]`
	}
	return `price:[${low}..${high}]`
}

function buildSearchFilter(search) {
	const filters = ['buyingOptions:{FIXED_PRICE}']
	const currency = getEbaySearchCurrency()
	const hasPrice = search.minPrice !== null || search.maxPrice !== null
	if (hasPrice && currency) {
		filters.push(buildPriceFilter(search.minPrice, search.maxPrice))
		filters.push(`priceCurrency:${currency}`)
	}
	if (search.condition !== null) {
		filters.push(`conditions:{${search.condition.toUpperCase()}}`)
	}
	return filters.join(',')
}

export async function searchEbayItems(search, limit = EBAY_SEARCH_LIMIT) {
	const keywords = readText(search.keywords)
	if (!keywords) {
		throw new Error('Search keywords are required')
	}
	const params = new URLSearchParams({
		q: keywords,
		limit: String(readSearchLimit(limit)),
		filter: buildSearchFilter(search),
	})
	const data = await ebayRequest('search', `/buy/browse/v1/item_summary/search?${params}`)

	const items = []
	if (!data || !Array.isArray(data.itemSummaries)) {
		return items
	}
	for (const record of data.itemSummaries) {
		const item = toEbayItem(record)
		if (!item) {
			console.warn('Skipping invalid eBay search result:', record)
			continue
		}
		items.push(item)
	}
	return items
}

function createCacheEntry() {
	return { value: null, fetchedAt: 0, failedAt: 0, request: null }
}

function isFresh(entry) {
	return entry.value !== null && Date.now() - entry.fetchedAt < FRANKFURTER_CACHE_MS
}

function failedRecently(entry) {
	return Date.now() - entry.failedAt < FRANKFURTER_RETRY_MS
}

async function refreshCacheEntry(entry, load) {
	try {
		entry.value = await load()
		entry.fetchedAt = Date.now()
	} catch (error) {
		entry.failedAt = Date.now()
		console.error('Frankfurter refresh failed:', error)
	} finally {
		entry.request = null
	}
}

async function readCacheEntry(entry, load) {
	if (!isFresh(entry) && !failedRecently(entry)) {
		if (!entry.request) {
			entry.request = refreshCacheEntry(entry, load)
		}
		await entry.request
	}
	const stale = entry.value !== null && !isFresh(entry)
	return { value: entry.value, stale }
}

async function frankfurterRequest(operation, path) {
	let response
	try {
		response = await fetch(`${config.frankfurter.baseUrl}${path}`, {
			signal: AbortSignal.timeout(FRANKFURTER_REQUEST_TIMEOUT_MS),
		})
	} catch (error) {
		await recordApiUsage('frankfurter', operation, false)
		throw new Error(`Frankfurter ${operation} request failed`, { cause: error })
	}

	await recordApiUsage('frankfurter', operation, response.ok)
	if (!response.ok) {
		throw new Error(`Frankfurter ${operation} request failed with status ${response.status}`)
	}
	return response.json()
}

function readCurrencyCode(value) {
	const code = readText(value).toUpperCase()
	if (!isCurrencyCode(code)) {
		return null
	}
	return code
}

function toCurrency(record) {
	if (!record || typeof record !== 'object') {
		return null
	}
	const code = readCurrencyCode(record.iso_code)
	const name = readText(record.name)
	if (!code || !name) {
		return null
	}
	return { code, name }
}

async function fetchCurrencies() {
	const data = await frankfurterRequest('currencies', '/v2/currencies')
	if (!Array.isArray(data)) {
		throw new Error('Frankfurter currencies response was invalid')
	}
	const currencies = []
	for (const record of data) {
		const currency = toCurrency(record)
		if (!currency) {
			console.warn('Skipping invalid Frankfurter currency:', record)
			continue
		}
		currencies.push(currency)
	}
	if (currencies.length === 0) {
		throw new Error('Frankfurter returned no currencies')
	}
	return currencies
}

export async function getSupportedCurrencies() {
	const cached = await readCacheEntry(currencyCache, fetchCurrencies)
	return { currencies: cached.value, stale: cached.stale }
}

function readRate(value) {
	const isNumber = typeof value === 'number' && Number.isFinite(value)
	if (!isNumber || value <= 0) {
		return null
	}
	return value
}

function toRate(record, base) {
	if (!record || typeof record !== 'object') {
		return null
	}
	const recordBase = readCurrencyCode(record.base)
	const quote = readCurrencyCode(record.quote)
	const rate = readRate(record.rate)
	const date = readText(record.date)
	if (recordBase !== base || !quote || rate === null || !date) {
		return null
	}
	return { quote, rate, date }
}

async function fetchRates(base) {
	const params = new URLSearchParams({ base })
	const data = await frankfurterRequest('rates', `/v2/rates?${params}`)
	if (!Array.isArray(data)) {
		throw new Error(`Frankfurter rates response for ${base} was invalid`)
	}
	const rates = new Map()
	for (const record of data) {
		const rate = toRate(record, base)
		if (!rate) {
			console.warn('Skipping invalid Frankfurter rate:', record)
			continue
		}
		rates.set(rate.quote, { rate: rate.rate, date: rate.date })
	}
	if (rates.size === 0) {
		throw new Error(`Frankfurter returned no rates for ${base}`)
	}
	return rates
}

async function getRates(base) {
	if (!rateCaches.has(base)) {
		rateCaches.set(base, createCacheEntry())
	}
	const entry = rateCaches.get(base)
	return readCacheEntry(entry, () => fetchRates(base))
}

function roundMoney(value) {
	return Math.round(value * 100) / 100
}

function readAmount(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null
	}
	return value
}

export async function convertPrice(amount, fromCurrency, toCurrency) {
	const price = readAmount(amount)
	const from = readCurrencyCode(fromCurrency)
	const to = readCurrencyCode(toCurrency)
	const result = {
		price,
		currency: from,
		displayPrice: price,
		displayCurrency: from,
		rate: null,
		rateDate: null,
		rateStale: false,
		converted: false,
	}
	if (!from || !to) {
		return result
	}
	if (from === to) {
		result.rate = 1
		result.converted = true
		return result
	}

	const rates = await getRates(from)
	if (!rates.value || !rates.value.has(to)) {
		return result
	}
	const quote = rates.value.get(to)
	if (price !== null) {
		result.displayPrice = roundMoney(price * quote.rate)
	}
	result.displayCurrency = to
	result.rate = quote.rate
	result.rateDate = quote.date
	result.rateStale = rates.stale
	result.converted = true
	return result
}

async function nrpRequest(operation, body) {
	if (!config.nrp.enabled) {
		throw new Error('Natural-language search is disabled')
	}
	let response
	try {
		response = await fetch(`${config.nrp.baseUrl}/chat/completions`, {
			method: 'POST',
			body: JSON.stringify(body),
			headers: {
				Authorization: `Bearer ${config.nrp.token}`,
				'Content-Type': 'application/json',
			},
			signal: AbortSignal.timeout(NRP_REQUEST_TIMEOUT_MS),
		})
	} catch (error) {
		await recordApiUsage('llm', operation, false)
		throw new Error(`NRP ${operation} request failed`, { cause: error })
	}

	await recordApiUsage('llm', operation, response.ok)
	if (!response.ok) {
		throw new Error(`NRP ${operation} request failed with status ${response.status}`)
	}
	return response.json()
}

function readReplyText(data) {
	if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
		return ''
	}
	const choice = data.choices[0]
	if (!choice || !choice.message) {
		return ''
	}
	return readText(choice.message.content)
}

function readJsonObject(text) {
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start === -1 || end < start) {
		return null
	}
	let value
	try {
		value = JSON.parse(text.slice(start, end + 1))
	} catch {
		return null
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null
	}
	return value
}

function isMissing(value) {
	return value === undefined || value === null
}

function isValidOptionalPrice(value) {
	if (isMissing(value)) {
		return true
	}
	return readPrice(value) !== null
}

function readOptionalPrice(value) {
	if (isMissing(value)) {
		return null
	}
	return readPrice(value)
}

function isValidOptionalCondition(value) {
	if (isMissing(value)) {
		return true
	}
	return SEARCH_CONDITIONS.includes(readText(value).toLowerCase())
}

function readOptionalCondition(value) {
	if (isMissing(value)) {
		return null
	}
	return readText(value).toLowerCase()
}

function toSearchParams(output) {
	if (!output) {
		return null
	}
	const keywords = readText(output.keywords)
	if (keywords === '' || keywords.length > MAX_SEARCH_KEYWORDS_LENGTH) {
		return null
	}
	if (!isValidOptionalPrice(output.minPrice) || !isValidOptionalPrice(output.maxPrice)) {
		return null
	}
	if (!isValidOptionalCondition(output.condition)) {
		return null
	}
	const minPrice = readOptionalPrice(output.minPrice)
	const maxPrice = readOptionalPrice(output.maxPrice)
	if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
		return null
	}
	return {
		keywords,
		minPrice,
		maxPrice,
		condition: readOptionalCondition(output.condition),
	}
}

export async function parseSearchQuery(query) {
	const text = readText(query)
	if (!text) {
		throw new Error('Search query is required')
	}
	const data = await nrpRequest('search', {
		model: config.nrp.model,
		temperature: 0,
		max_tokens: NRP_MAX_REPLY_TOKENS,
		messages: [
			{ role: 'system', content: SEARCH_PROMPT },
			{ role: 'user', content: text },
		],
	})

	const reply = readReplyText(data)
	const output = readJsonObject(reply)
	const params = toSearchParams(output)
	if (!params) {
		console.warn('Skipping invalid LLM search output:', reply)
	}
	return params
}
