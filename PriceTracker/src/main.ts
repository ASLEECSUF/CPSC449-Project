import type { RealtimeChannel, RealtimePostgresInsertPayload } from '@supabase/supabase-js'
import { apiRequest } from './api.ts'
import { drawPriceGraph } from './graph.ts'
import type { HistoryPoint } from './graph.ts'
import { supabase } from './supabase.ts'
import './style.css'

interface Currency {
	code: string
	name: string
}

interface TrackedItem {
	id: string
	vendor: string
	url: string
	name: string
	currency: string | null
	currentPrice: number | null
	displayCurrency: string | null
	displayCurrentPrice: number | null
	displayTargetPrice: number | null
	rate: number | null
	rateDate: string | null
	rateStale: boolean
	converted: boolean
}

interface SearchResult {
	itemId: string
	url: string
	name: string
	condition: string | null
	price: number | null
	currency: string | null
	displayPrice: number | null
	displayCurrency: string | null
	converted: boolean
}

interface ChatMessage {
	role: 'user' | 'assistant'
	content: string
}

interface ChatSearch {
	keywords: string
	minPrice: number | null
	maxPrice: number | null
	priceCurrency: string
	condition: string | null
	priceFilterSkipped: boolean
}

interface ChatReply {
	reply: string
	search: ChatSearch | null
	results: SearchResult[]
}

const ITEM_COLUMN_COUNT = 8
const SEARCH_COLUMN_TITLES = ['Name', 'Condition', 'Price', 'Native Price', 'Track']
const MAX_CHAT_MESSAGES = 30
const CHAT_GREETING = "Hi! Tell me what you're shopping for and I'll find options on eBay."

const statusText = document.querySelector<HTMLParagraphElement>('#status')!
const authSection = document.querySelector<HTMLElement>('#auth-section')!
const accountSection = document.querySelector<HTMLElement>('#account-section')!
const accountEmail = document.querySelector<HTMLSpanElement>('#account-email')!
const signupForm = document.querySelector<HTMLFormElement>('#signup-form')!
const loginForm = document.querySelector<HTMLFormElement>('#login-form')!
const logoutButton = document.querySelector<HTMLButtonElement>('#logout-button')!
const settingsSection = document.querySelector<HTMLElement>('#settings-section')!
const currencyForm = document.querySelector<HTMLFormElement>('#currency-form')!
const currencySelect = document.querySelector<HTMLSelectElement>('#currency-select')!
const itemsSection = document.querySelector<HTMLElement>('#items-section')!
const addItemForm = document.querySelector<HTMLFormElement>('#add-item-form')!
const addItemButton = document.querySelector<HTMLButtonElement>('#add-item-button')!
const itemsBody = document.querySelector<HTMLTableSectionElement>('#items-body')!
const historySection = document.querySelector<HTMLElement>('#history-section')!
const historyName = document.querySelector<HTMLSpanElement>('#history-name')!
const historyNote = document.querySelector<HTMLParagraphElement>('#history-note')!
const historyGraph = document.querySelector<SVGSVGElement>('#history-graph')!
const chatSection = document.querySelector<HTMLElement>('#chat-section')!
const chatLog = document.querySelector<HTMLDivElement>('#chat-log')!
const chatForm = document.querySelector<HTMLFormElement>('#chat-form')!
const chatInput = document.querySelector<HTMLInputElement>('#chat-input')!
const chatButton = document.querySelector<HTMLButtonElement>('#chat-button')!
const chatClearButton = document.querySelector<HTMLButtonElement>('#chat-clear-button')!

let trackedItems: TrackedItem[] = []
let chatHistory: ChatMessage[] = []
let historyItemId: string | null = null
let historyPoints: HistoryPoint[] = []
let historyCurrency = ''
let priceChannel: RealtimeChannel | null = null

function showStatus(message: string) {
	statusText.textContent = message
}

function readErrorText(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}
	return 'Something went wrong'
}

function readCredentials(form: HTMLFormElement) {
	const fields = new FormData(form)
	return {
		email: String(fields.get('email')),
		password: String(fields.get('password')),
	}
}

function readText(value: unknown): string {
	if (typeof value !== 'string') {
		return ''
	}
	return value
}

function readNumber(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null
	}
	return value
}

function roundMoney(value: number): number {
	return Math.round(value * 100) / 100
}

function formatPrice(price: number | null, currency: string | null): string {
	if (price === null) {
		return ''
	}
	if (!currency) {
		return price.toFixed(2)
	}
	return `${price.toFixed(2)} ${currency}`
}

function vendorLabel(vendor: string): string {
	if (vendor === 'amazon') {
		return 'Amazon'
	}
	if (vendor === 'ebay') {
		return 'eBay'
	}
	return vendor
}

function describeRate(item: TrackedItem): string {
	if (!item.converted) {
		return 'Unavailable, showing native price'
	}
	if (!item.rateDate) {
		return ''
	}
	if (item.rateStale) {
		return `${item.rateDate} (may be out of date)`
	}
	return item.rateDate
}

function addCell(row: HTMLTableRowElement, text: string): HTMLTableCellElement {
	const cell = row.insertCell()
	cell.textContent = text
	return cell
}

function createButton(label: string, onClick: () => void): HTMLButtonElement {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = label
	button.addEventListener('click', onClick)
	return button
}

function createTargetInput(item: TrackedItem): HTMLInputElement {
	const input = document.createElement('input')
	input.type = 'number'
	input.min = '0'
	input.step = '0.01'
	if (item.displayTargetPrice !== null) {
		input.value = String(item.displayTargetPrice)
	}
	return input
}

function buildItemRow(item: TrackedItem): HTMLTableRowElement {
	const row = document.createElement('tr')
	row.dataset.itemId = item.id
	addCell(row, vendorLabel(item.vendor))
	addCell(row, item.name)
	addCell(row, formatPrice(item.displayCurrentPrice, item.displayCurrency))
	addCell(row, formatPrice(item.currentPrice, item.currency))

	const targetInput = createTargetInput(item)
	const targetCell = row.insertCell()
	targetCell.append(targetInput)
	targetCell.append(` ${item.displayCurrency ?? ''} `)
	targetCell.append(createButton('Save', () => saveTargetPrice(item.id, targetInput)))

	const actionsCell = row.insertCell()
	actionsCell.append(createButton('History', () => showHistory(item.id)))
	actionsCell.append(' ')
	actionsCell.append(createButton('Remove', () => removeItem(item.id)))

	addCell(row, describeRate(item))

	const linkCell = row.insertCell()
	linkCell.append(createLink(`View on ${vendorLabel(item.vendor)}`, item.url))
	return row
}

function renderItems() {
	itemsBody.replaceChildren()
	if (trackedItems.length === 0) {
		const row = itemsBody.insertRow()
		const cell = addCell(row, 'No tracked items yet.')
		cell.colSpan = ITEM_COLUMN_COUNT
		return
	}
	for (const item of trackedItems) {
		itemsBody.append(buildItemRow(item))
	}
}

function findTrackedItem(itemId: string): TrackedItem | null {
	for (const item of trackedItems) {
		if (item.id === itemId) {
			return item
		}
	}
	return null
}

function findItemRow(itemId: string): HTMLTableRowElement | null {
	for (let index = 0; index < itemsBody.rows.length; index++) {
		const row = itemsBody.rows[index]
		if (row.dataset.itemId === itemId) {
			return row
		}
	}
	return null
}

function replaceTrackedItem(updated: TrackedItem) {
	for (let index = 0; index < trackedItems.length; index++) {
		if (trackedItems[index].id === updated.id) {
			trackedItems[index] = updated
		}
	}
	const row = findItemRow(updated.id)
	if (row) {
		row.replaceWith(buildItemRow(updated))
	}
}

function removeTrackedItem(itemId: string) {
	const remaining: TrackedItem[] = []
	for (const item of trackedItems) {
		if (item.id !== itemId) {
			remaining.push(item)
		}
	}
	trackedItems = remaining
}

async function loadItems() {
	try {
		const body = await apiRequest('GET', '/api/items')
		trackedItems = body.items
		renderItems()
	} catch (error) {
		showStatus(readErrorText(error))
	}
}

async function handleAddItem(event: SubmitEvent) {
	event.preventDefault()
	const fields = new FormData(addItemForm)
	showStatus('Loading...')
	addItemButton.disabled = true
	try {
		await apiRequest('POST', '/api/items', { input: String(fields.get('input')) })
		addItemForm.reset()
		showStatus('')
		await loadItems()
	} catch (error) {
		showStatus(readErrorText(error))
	}
	addItemButton.disabled = false
}

async function saveTargetPrice(itemId: string, input: HTMLInputElement) {
	if (input.validity.badInput) {
		showStatus('Target price must be a number')
		return
	}

	let targetPrice: number | null = null
	const text = input.value.trim()
	if (text !== '') {
		targetPrice = Number(text)
		if (!Number.isFinite(targetPrice) || targetPrice < 0) {
			showStatus('Target price must be 0 or more')
			return
		}
	}

	showStatus('Saving target price...')
	try {
		const item = await apiRequest('PATCH', `/api/items/${itemId}`, { targetPrice })
		replaceTrackedItem(item)
		showStatus('Target price saved.')
	} catch (error) {
		showStatus(readErrorText(error))
	}
}

async function removeItem(itemId: string) {
	showStatus('Removing item...')
	try {
		await apiRequest('DELETE', `/api/items/${itemId}`)
	} catch (error) {
		showStatus(readErrorText(error))
		return
	}

	removeTrackedItem(itemId)
	renderItems()
	if (historyItemId === itemId) {
		hideHistory()
	}
	showStatus('')
}

function redrawHistory() {
	drawPriceGraph(historyGraph, historyPoints, historyCurrency)
}

function hideHistory() {
	historyItemId = null
	historyPoints = []
	historyCurrency = ''
	historySection.hidden = true
	historyName.textContent = ''
	historyNote.textContent = ''
	historyGraph.replaceChildren()
}

function describeHistoryNote(item: TrackedItem): string {
	if (!item.converted) {
		return 'The exchange rate is unavailable, so prices are shown in the native currency.'
	}
	return ''
}

async function showHistory(itemId: string) {
	showStatus('Loading history...')
	let body
	try {
		body = await apiRequest('GET', `/api/items/${itemId}/history`)
	} catch (error) {
		showStatus(readErrorText(error))
		return
	}

	historyItemId = itemId
	historyPoints = body.points
	historyCurrency = body.item.displayCurrency ?? ''
	historyName.textContent = body.item.name
	historyNote.textContent = describeHistoryNote(body.item)
	historySection.hidden = false
	redrawHistory()
	showStatus('')
}

async function reloadPrices() {
	await loadItems()
	if (historyItemId) {
		await showHistory(historyItemId)
	}
}

function convertWithItemRate(item: TrackedItem, price: number, currency: string): number | null {
	if (!item.converted || item.rate === null) {
		return null
	}
	if (currency !== item.currency) {
		return null
	}
	return roundMoney(price * item.rate)
}

async function handlePriceInsert(payload: RealtimePostgresInsertPayload<Record<string, unknown>>) {
	const entry = payload.new
	const item = findTrackedItem(readText(entry.item_id))
	const price = readNumber(entry.price)
	if (!item || price === null) {
		return
	}

	const currency = readText(entry.currency)
	const displayPrice = convertWithItemRate(item, price, currency)
	if (displayPrice === null) {
		await reloadPrices()
		return
	}

	item.currentPrice = price
	item.displayCurrentPrice = displayPrice
	replaceTrackedItem(item)

	if (historyItemId === item.id) {
		historyPoints.push({
			id: readText(entry.id),
			recordedAt: readText(entry.recorded_at),
			price,
			currency,
			displayPrice,
			displayCurrency: item.displayCurrency,
		})
		redrawHistory()
	}
}

function startPriceUpdates() {
	if (priceChannel) {
		return
	}
	priceChannel = supabase
		.channel('price_history_changes')
		.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'price_history' }, handlePriceInsert)
		.subscribe()
}

async function stopPriceUpdates() {
	if (!priceChannel) {
		return
	}
	await supabase.removeChannel(priceChannel)
	priceChannel = null
}

function describePriceLimit(search: ChatSearch): string {
	const low = formatPrice(search.minPrice, search.priceCurrency)
	const high = formatPrice(search.maxPrice, search.priceCurrency)
	if (low !== '' && high !== '') {
		return `between ${low} and ${high}`
	}
	if (low !== '') {
		return `at least ${low}`
	}
	if (high !== '') {
		return `up to ${high}`
	}
	return ''
}

function hasUnconvertedResult(results: SearchResult[]): boolean {
	for (const result of results) {
		if (!result.converted) {
			return true
		}
	}
	return false
}

function describeSearch(search: ChatSearch, results: SearchResult[]): string {
	let text = `Searched eBay for "${search.keywords}"`
	if (search.condition) {
		text += `, ${search.condition} only`
	}
	const priceLimit = describePriceLimit(search)
	if (priceLimit !== '') {
		text += `, ${priceLimit}`
	}
	text += '.'
	if (search.priceFilterSkipped) {
		text += ' The price limit was not applied because exchange rates are unavailable.'
	}
	if (hasUnconvertedResult(results)) {
		text += ' Some prices are in their native currency because exchange rates are unavailable.'
	}
	return text
}

function createLink(text: string, url: string): HTMLAnchorElement {
	const link = document.createElement('a')
	link.href = url
	link.target = '_blank'
	link.rel = 'noopener'
	link.textContent = text
	return link
}

async function trackSearchResult(result: SearchResult, button: HTMLButtonElement) {
	showStatus('Adding item...')
	button.disabled = true
	try {
		await apiRequest('POST', '/api/items', { input: result.itemId })
	} catch (error) {
		showStatus(readErrorText(error))
		button.disabled = false
		return
	}
	button.textContent = 'Tracked'
	showStatus('')
	await loadItems()
}

function buildSearchRow(result: SearchResult): HTMLTableRowElement {
	const row = document.createElement('tr')
	const nameCell = row.insertCell()
	nameCell.append(createLink(result.name, result.url))
	addCell(row, result.condition ?? '')
	addCell(row, formatPrice(result.displayPrice, result.displayCurrency))
	addCell(row, formatPrice(result.price, result.currency))

	const trackCell = row.insertCell()
	const trackButton = createButton('Track', () => trackSearchResult(result, trackButton))
	trackCell.append(trackButton)
	return row
}

function buildResultsTable(results: SearchResult[]): HTMLTableElement {
	const table = document.createElement('table')
	const headerRow = table.createTHead().insertRow()
	for (const title of SEARCH_COLUMN_TITLES) {
		const header = document.createElement('th')
		header.textContent = title
		headerRow.append(header)
	}
	const body = table.createTBody()
	for (const result of results) {
		body.append(buildSearchRow(result))
	}
	return table
}

function chatLabel(role: string): string {
	if (role === 'user') {
		return 'You'
	}
	return 'Assistant'
}

function createChatMessage(role: string, text: string): HTMLDivElement {
	const message = document.createElement('div')
	message.className = `chat-message chat-${role}`
	const label = document.createElement('strong')
	label.textContent = chatLabel(role)
	const body = document.createElement('p')
	body.textContent = text
	message.append(label, body)
	return message
}

function scrollChatToEnd() {
	chatLog.scrollTop = chatLog.scrollHeight
}

function showChatMessage(message: HTMLDivElement) {
	chatLog.append(message)
	scrollChatToEnd()
}

function showChatReply(body: ChatReply) {
	const message = createChatMessage('assistant', body.reply)
	if (body.search) {
		const note = document.createElement('p')
		note.className = 'chat-note'
		note.textContent = describeSearch(body.search, body.results)
		message.append(note)
	}
	if (body.results.length > 0) {
		message.append(buildResultsTable(body.results))
	}
	showChatMessage(message)
}

function rememberChatReply(body: ChatReply) {
	let content = body.reply
	if (body.search) {
		content += `\n[${describeSearch(body.search, body.results)}]`
	}
	chatHistory.push({ role: 'assistant', content })
}

function recentChatHistory(): ChatMessage[] {
	let start = 0
	if (chatHistory.length > MAX_CHAT_MESSAGES) {
		start = chatHistory.length - MAX_CHAT_MESSAGES
	}
	while (start < chatHistory.length && chatHistory[start].role !== 'user') {
		start++
	}
	return chatHistory.slice(start)
}

function clearChat() {
	chatHistory = []
	chatLog.replaceChildren()
	chatForm.reset()
	showChatMessage(createChatMessage('assistant', CHAT_GREETING))
}

async function handleChat(event: SubmitEvent) {
	event.preventDefault()
	const text = chatInput.value.trim()
	if (text === '') {
		return
	}

	chatHistory.push({ role: 'user', content: text })
	const userMessage = createChatMessage('user', text)
	showChatMessage(userMessage)
	chatForm.reset()
	showStatus('The assistant is thinking...')
	chatButton.disabled = true
	try {
		const body: ChatReply = await apiRequest('POST', '/api/chat', { messages: recentChatHistory() })
		showChatReply(body)
		rememberChatReply(body)
		showStatus('')
	} catch (error) {
		chatHistory.pop()
		userMessage.remove()
		chatInput.value = text
		showStatus(readErrorText(error))
	}
	chatButton.disabled = false
}

function fillCurrencySelect(currencies: Currency[], selectedCode: string) {
	currencySelect.replaceChildren()
	for (const currency of currencies) {
		const option = document.createElement('option')
		option.value = currency.code
		option.textContent = `${currency.code} - ${currency.name}`
		if (currency.code === selectedCode) {
			option.selected = true
		}
		currencySelect.append(option)
	}
}

async function loadCurrencies(preferredCurrency: string) {
	try {
		const body = await apiRequest('GET', '/api/currencies')
		fillCurrencySelect(body.currencies, preferredCurrency)
	} catch (error) {
		showStatus(readErrorText(error))
	}
}

async function handleSaveCurrency(event: SubmitEvent) {
	event.preventDefault()
	showStatus('Saving currency...')
	try {
		await apiRequest('PATCH', '/api/profile', { preferredCurrency: currencySelect.value })
	} catch (error) {
		showStatus(readErrorText(error))
		return
	}
	await reloadPrices()
	showStatus('Currency saved.')
}

function showSignedOut() {
	authSection.hidden = false
	accountSection.hidden = true
	settingsSection.hidden = true
	itemsSection.hidden = true
	chatSection.hidden = true
	accountEmail.textContent = ''
	currencySelect.replaceChildren()
	trackedItems = []
	itemsBody.replaceChildren()
	clearChat()
	hideHistory()
}

function showSignedIn(email: string) {
	authSection.hidden = true
	accountSection.hidden = false
	settingsSection.hidden = false
	itemsSection.hidden = false
	chatSection.hidden = false
	accountEmail.textContent = email
}

async function loadAccount() {
	const { data } = await supabase.auth.getSession()
	if (!data.session) {
		showSignedOut()
		return
	}

	showSignedIn(data.session.user.email ?? '')
	let profile
	try {
		profile = await apiRequest('GET', '/api/profile')
	} catch (error) {
		showStatus(readErrorText(error))
		return
	}

	showSignedIn(profile.email)
	startPriceUpdates()
	await loadCurrencies(profile.preferredCurrency)
	await loadItems()
}

async function keepSession(body: any) {
	const { error } = await supabase.auth.setSession({
		access_token: body.accessToken,
		refresh_token: body.refreshToken,
	})
	if (error) {
		throw error
	}
}

async function handleSignup(event: SubmitEvent) {
	event.preventDefault()
	showStatus('Signing up...')
	try {
		const body = await apiRequest('POST', '/api/auth/signup', readCredentials(signupForm))
		signupForm.reset()
		if (body.emailConfirmationRequired) {
			showStatus('Account created. Open the link in the confirmation email, then log in.')
			return
		}
		await keepSession(body)
		showStatus('')
		await loadAccount()
	} catch (error) {
		showStatus(readErrorText(error))
	}
}

async function handleLogin(event: SubmitEvent) {
	event.preventDefault()
	showStatus('Logging in...')
	try {
		const body = await apiRequest('POST', '/api/auth/login', readCredentials(loginForm))
		loginForm.reset()
		await keepSession(body)
		showStatus('')
		await loadAccount()
	} catch (error) {
		showStatus(readErrorText(error))
	}
}

async function handleLogout() {
	await stopPriceUpdates()
	const { error } = await supabase.auth.signOut()
	if (error) {
		showStatus(readErrorText(error))
	} else {
		showStatus('')
	}
	showSignedOut()
}

signupForm.addEventListener('submit', handleSignup)
loginForm.addEventListener('submit', handleLogin)
logoutButton.addEventListener('click', handleLogout)
currencyForm.addEventListener('submit', handleSaveCurrency)
addItemForm.addEventListener('submit', handleAddItem)
chatForm.addEventListener('submit', handleChat)
chatClearButton.addEventListener('click', clearChat)

clearChat()
loadAccount()
