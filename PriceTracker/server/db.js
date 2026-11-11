import { createClient } from '@supabase/supabase-js'
import config from './config.js'

const serverAuthOptions = {
	auth: {
		autoRefreshToken: false,
		persistSession: false,
		detectSessionInUrl: false,
	},
}

const supabaseAdmin = createClient(
	config.supabase.url,
	config.supabase.serviceRoleKey,
	serverAuthOptions,
)

function createAuthClient() {
	return createClient(config.supabase.url, config.supabase.anonKey, serverAuthOptions)
}

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

export async function getUserForToken(token) {
	const { data, error } = await supabaseAdmin.auth.getUser(token)
	if (error) {
		throw error
	}
	return data.user
}

export async function findProfile(userId) {
	const { data, error } = await supabaseAdmin
		.from('profiles')
		.select('role, disabled, preferred_currency')
		.eq('id', userId)
		.maybeSingle()
	if (error) {
		throw error
	}
	return data
}

export async function updatePreferredCurrency(userId, currency) {
	const { data, error } = await supabaseAdmin
		.from('profiles')
		.update({ preferred_currency: currency })
		.eq('id', userId)
		.select('role, disabled, preferred_currency')
		.single()
	if (error) {
		throw error
	}
	return data
}

export async function recordApiUsage(service, operation, succeeded) {
	const { error } = await supabaseAdmin
		.from('api_usage')
		.insert({ service, operation, succeeded })
	if (error) {
		console.error(`Recording ${service} API usage failed:`, error)
	}
}

const ITEM_COLUMNS ='id, user_id, vendor, vendor_item_id, url, name, target_price, current_price, currency, created_at'

export async function listOwnedItems(userId) {
	const { data, error } = await supabaseAdmin
		.from('tracked_items')
		.select(ITEM_COLUMNS)
		.eq('user_id', userId)
		.order('created_at', { ascending: false })
	if (error) {
		throw error
	}
	return data
}

export async function findOwnedItem(userId, itemId) {
	const { data, error } = await supabaseAdmin
		.from('tracked_items')
		.select(ITEM_COLUMNS)
		.eq('id', itemId)
		.eq('user_id', userId)
		.maybeSingle()
	if (error) {
		throw error
	}
	return data
}

export async function findOwnedItemByVendorId(userId, vendor, vendorItemId) {
	const { data, error } = await supabaseAdmin
		.from('tracked_items')
		.select(ITEM_COLUMNS)
		.eq('user_id', userId)
		.eq('vendor', vendor)
		.eq('vendor_item_id', vendorItemId)
		.maybeSingle()
	if (error) {
		throw error
	}
	return data
}

export async function isVendorEnabled(name) {
	const { data, error } = await supabaseAdmin
		.from('vendors')
		.select('enabled')
		.eq('name', name)
		.maybeSingle()
	if (error) {
		throw error
	}
	if (!data) {
		return false
	}
	return data.enabled
}

export async function insertTrackedItem(userId, product) {
	const { data, error } = await supabaseAdmin
		.from('tracked_items')
		.insert({
			user_id: userId,
			vendor: product.vendor,
			vendor_item_id: product.vendorItemId,
			url: product.url,
			name: product.name,
			current_price: product.price,
			currency: product.currency,
		})
		.select(ITEM_COLUMNS)
		.single()
	if (error) {
		throw error
	}
	return data
}

export async function updateOwnedTargetPrice(userId, itemId, targetPrice) {
	const { data, error } = await supabaseAdmin
		.from('tracked_items')
		.update({ target_price: targetPrice })
		.eq('id', itemId)
		.eq('user_id', userId)
		.select(ITEM_COLUMNS)
		.single()
	if (error) {
		throw error
	}
	return data
}

export async function deleteOwnedItem(userId, itemId) {
	const { error } = await supabaseAdmin
		.from('tracked_items')
		.delete()
		.eq('id', itemId)
		.eq('user_id', userId)
	if (error) {
		throw error
	}
}

export async function listVendorItems(vendor) {
	const { data, error } = await supabaseAdmin
		.from('tracked_items')
		.select('id, vendor_item_id, url, current_price, currency')
		.eq('vendor', vendor)
	if (error) {
		throw error
	}
	return data
}

export async function updateItemPrice(itemId, price, currency) {
	const { error } = await supabaseAdmin
		.from('tracked_items')
		.update({ current_price: price, currency })
		.eq('id', itemId)
	if (error) {
		throw error
	}
}

export async function insertPriceHistory(itemId, price, currency) {
	const { error } = await supabaseAdmin
		.from('price_history')
		.insert({ item_id: itemId, price, currency })
	if (error) {
		throw error
	}
}

export async function listOwnedPriceHistory(userId, itemId) {
	const { data, error } = await supabaseAdmin
		.from('price_history')
		.select('id, item_id, price, currency, recorded_at, tracked_items!inner(user_id)')
		.eq('item_id', itemId)
		.eq('tracked_items.user_id', userId)
		.order('recorded_at', { ascending: true })
	if (error) {
		throw error
	}
	return data.map((entry) => ({
		id: entry.id,
		item_id: entry.item_id,
		price: entry.price,
		currency: entry.currency,
		recorded_at: entry.recorded_at,
	}))
}
