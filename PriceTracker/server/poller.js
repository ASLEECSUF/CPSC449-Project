import { getEbayItem, scrapeAmazonProducts } from './apis.js'
import config from './config.js'
import { insertPriceHistory, isVendorEnabled, listVendorItems, updateItemPrice } from './db.js'

const AMAZON_POLL_INTERVAL_MS = 21_600_000
const EBAY_POLL_INTERVAL_MS = 1_800_000

const vendors = [
	{
		name: 'amazon',
		label: 'Amazon',
		configured: config.brightData.enabled,
		intervalMs: AMAZON_POLL_INTERVAL_MS,
		fetchPrices: fetchAmazonPrices,
		running: false,
		timer: null,
	},
	{
		name: 'ebay',
		label: 'eBay',
		configured: config.ebay.enabled,
		intervalMs: EBAY_POLL_INTERVAL_MS,
		fetchPrices: fetchEbayPrices,
		running: false,
		timer: null,
	},
]

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
			console.error(`eBay lookup for item ${itemId} failed:`, error)
			continue
		}
		if (!product) {
			console.warn(`eBay item ${itemId} has no current price`)
			continue
		}
		prices.set(itemId, product)
	}
	return prices
}

function hasPriceChanged(item, product) {
	if (item.currency !== product.currency) {
		return true
	}
	return item.current_price !== product.price
}

async function recordPrice(item, product) {
	await insertPriceHistory(item.id, product.price, product.currency)
	await updateItemPrice(item.id, product.price, product.currency)
}

async function recordChangedPrices(groups, prices) {
	let recorded = 0
	for (const vendorItemId of groups.keys()) {
		const product = prices.get(vendorItemId)
		if (!product) {
			continue
		}
		for (const item of groups.get(vendorItemId)) {
			if (!hasPriceChanged(item, product)) {
				continue
			}
			try {
				await recordPrice(item, product)
				recorded++
			} catch (error) {
				console.error(`Recording a new price for tracked item ${item.id} failed:`, error)
			}
		}
	}
	return recorded
}

async function runVendorPoll(vendor) {
	const enabled = await isVendorEnabled(vendor.name)
	if (!enabled) {
		return
	}

	const items = await listVendorItems(vendor.name)
	if (items.length === 0) {
		return
	}

	const groups = groupByVendorItemId(items)
	const prices = await vendor.fetchPrices(groups)
	const recorded = await recordChangedPrices(groups, prices)
	console.log(`${vendor.label} poll checked ${groups.size} items and recorded ${recorded} price changes`)
}

async function pollVendor(vendor) {
	if (vendor.running) {
		return
	}
	vendor.running = true
	try {
		await runVendorPoll(vendor)
	} catch (error) {
		console.error(`${vendor.label} price poll failed:`, error)
	} finally {
		vendor.running = false
	}
}

export function startPoller() {
	for (const vendor of vendors) {
		if (!vendor.configured || vendor.timer) {
			continue
		}
		vendor.timer = setInterval(() => pollVendor(vendor), vendor.intervalMs)
	}
}
