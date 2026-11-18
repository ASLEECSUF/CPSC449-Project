import { apiRequest } from './api.ts'
import { supabase } from './supabase.ts'

const statusText = document.querySelector<HTMLParagraphElement>('#status')!
const authSection = document.querySelector<HTMLElement>('#auth-section')!
const accountSection = document.querySelector<HTMLElement>('#account-section')!
const accountEmail = document.querySelector<HTMLSpanElement>('#account-email')!
const signupForm = document.querySelector<HTMLFormElement>('#signup-form')!
const loginForm = document.querySelector<HTMLFormElement>('#login-form')!
const logoutButton = document.querySelector<HTMLButtonElement>('#logout-button')!

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

function showSignedOut() {
	authSection.hidden = false
	accountSection.hidden = true
	accountEmail.textContent = ''
}

function showSignedIn(email: string) {
	authSection.hidden = true
	accountSection.hidden = false
	accountEmail.textContent = email
}

async function loadAccount() {
	const { data } = await supabase.auth.getSession()
	if (!data.session) {
		showSignedOut()
		return
	}

	showSignedIn(data.session.user.email ?? '')
	try {
		const profile = await apiRequest('GET', '/api/profile')
		showSignedIn(profile.email)
	} catch (error) {
		showStatus(readErrorText(error))
	}
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

loadAccount()
