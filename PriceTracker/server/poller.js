import { getEbayItem, scrapeAmazonProducts } from './apis.js'
import config from './config.js'
import { insertPriceHistory, isVendorEnabled, listVendorItems, updateItemPrice } from './db.js'

const MS_PER_MINUTE = 60_000

const vendors = [
	{
		name: 'amazon',
		label: 'Amazon',
		configured: config.brightData.enabled,
		missingSetting: 'BRIGHTDATA_API_KEY is not set',
		intervalMinutes: config.polling.amazonIntervalMinutes,
		fetchPrices: fetchAmazonPrices,
		running: false,
		timer: null,
	},
	{
		name: 'ebay',
		label: 'eBay',
		configured: config.ebay.enabled,
		missingSetting: 'EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are not both set',
		intervalMinutes: config.polling.ebayIntervalMinutes,
		fetchPrices: fetchEbayPrices,
		running: false,
		timer: null,
	},
]

function withTime(message) {
	return `[${new Date().toISOString()}] ${message}`
}

function groupByVendorItemId(items) {
	const groups = new Map()
	for (const item of items) {
		if (!groups.has(item.vendor_item_id)) {
			groups.set(item.vendor_item_id, [])
		}
		groups.get(item.vendor_item_id).push(item)
	}
	return groups
}

async function fetchAmazonPrices(groups) {
	const urls = []
	for (const items of groups.values()) {
		urls.push(items[0].url)
	}

	const products = await scrapeAmazonProducts(urls)
	const prices = new Map()
	for (const product of products) {
		prices.set(product.asin, product)
	}
	return prices
}

async function fetchEbayPrices(groups) {
	const prices = new Map()
	for (const itemId of groups.keys()) {
		let product
		try {
			product = await getEbayItem(itemId)
		} catch (error) {
			console.error(withTime(`eBay lookup for item ${itemId} failed:`), error)
			continue
		}
		if (!product) {
			console.warn(withTime(`eBay item ${itemId} has no current price`))
			continue
		}
		prices.set(itemId, product)
	}
	return prices
}

function countMissingPrices(groups, prices) {
	let missing = 0
	for (const vendorItemId of groups.keys()) {
		if (!prices.has(vendorItemId)) {
			missing++
		}
	}
	return missing
}

function hasPriceChanged(item, product) {
	if (item.currency !== product.currency) {
		return true
	}
	return item.current_price !== product.price
}

async function recordPrice(item, product) {
	await insertPriceHistory(item.id, product.price, product.currency)
	if (hasPriceChanged(item, product)) {
		await updateItemPrice(item.id, product.price, product.currency)
	}
}

async function recordPrices(groups, prices) {
	const result = { recorded: 0, failed: 0 }
	for (const vendorItemId of groups.keys()) {
		const product = prices.get(vendorItemId)
		if (!product) {
			continue
		}
		for (const item of groups.get(vendorItemId)) {
			try {
				await recordPrice(item, product)
				result.recorded++
			} catch (error) {
				result.failed++
				console.error(withTime(`Recording a new price for tracked item ${item.id} failed:`), error)
			}
		}
	}
	return result
}

async function runVendorPoll(vendor) {
	const enabled = await isVendorEnabled(vendor.name)
	if (!enabled) {
		console.log(withTime(`${vendor.label} poll skipped: vendor is disabled`))
		return
	}

	const items = await listVendorItems(vendor.name)
	if (items.length === 0) {
		console.log(withTime(`${vendor.label} poll skipped: no tracked items`))
		return
	}

	const groups = groupByVendorItemId(items)
	console.log(withTime(`${vendor.label} poll started for ${groups.size} items`))
	const startedAt = Date.now()
	const prices = await vendor.fetchPrices(groups)
	const missing = countMissingPrices(groups, prices)
	const result = await recordPrices(groups, prices)
	const seconds = Math.round((Date.now() - startedAt) / 1000)

	console.log(withTime(`${vendor.label} poll finished in ${seconds}s: recorded ${result.recorded} prices`))
	if (missing > 0) {
		console.warn(withTime(`${vendor.label} poll could not get a price for ${missing} of ${groups.size} items`))
	}
	if (result.failed > 0) {
		console.error(withTime(`${vendor.label} poll failed to save ${result.failed} prices`))
	}
}

async function pollVendor(vendor) {
	if (vendor.running) {
		console.warn(withTime(`${vendor.label} poll skipped: the previous poll is still running`))
		return
	}
	vendor.running = true
	try {
		await runVendorPoll(vendor)
	} catch (error) {
		console.error(withTime(`${vendor.label} price poll failed:`), error)
	} finally {
		vendor.running = false
	}
}

export function startPoller() {
	for (const vendor of vendors) {
		if (vendor.timer) {
			continue
		}
		if (!vendor.configured) {
			console.warn(withTime(`${vendor.label} polling is off: ${vendor.missingSetting}`))
			continue
		}
		const intervalMs = vendor.intervalMinutes * MS_PER_MINUTE
		vendor.timer = setInterval(() => pollVendor(vendor), intervalMs)
		console.log(withTime(`${vendor.label} polling every ${vendor.intervalMinutes} minutes`))
	}
	console.log(withTime('Price poller started'))
}

export function stopPoller() {
	for (const vendor of vendors) {
		if (!vendor.timer) {
			continue
		}
		clearInterval(vendor.timer)
		vendor.timer = null
		if (vendor.running) {
			console.warn(withTime(`${vendor.label} poll was still running when the poller stopped`))
		}
	}
	console.log(withTime('Price poller stopped'))
}
