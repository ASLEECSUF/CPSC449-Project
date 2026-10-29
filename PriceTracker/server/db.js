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
