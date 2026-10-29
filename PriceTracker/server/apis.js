import { setTimeout as sleep } from 'node:timers/promises'
import config from './config.js'
import { recordApiUsage } from './db.js'

const BRIGHTDATA_BASE_URL = 'https://api.brightdata.com/datasets/v3'
const BRIGHTDATA_REQUEST_TIMEOUT_MS = 90_000
const BRIGHTDATA_SNAPSHOT_WAIT_MS = 120_000
const BRIGHTDATA_SNAPSHOT_POLL_MS = 10_000
const AMAZON_BATCH_SIZE = 20
const UPPERCASE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'

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
