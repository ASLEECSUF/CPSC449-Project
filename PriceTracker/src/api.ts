import { supabase } from './supabase.ts'

async function getAccessToken(): Promise<string | null> {
	const { data } = await supabase.auth.getSession()
	if (!data.session) {
		return null
	}
	return data.session.access_token
}

async function readJson(response: Response): Promise<any> {
	const text = await response.text()
	if (text === '') {
		return null
	}
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function readErrorMessage(body: any, status: number): string {
	if (body && typeof body.error === 'string') {
		return body.error
	}
	return `Request failed with status ${status}`
}

export async function apiRequest(method: string, path: string, body?: unknown): Promise<any> {
	const headers: Record<string, string> = {}
	const token = await getAccessToken()
	if (token) {
		headers['Authorization'] = `Bearer ${token}`
	}

	const options: RequestInit = { method, headers }
	if (body !== undefined) {
		headers['Content-Type'] = 'application/json'
		options.body = JSON.stringify(body)
	}

	const response = await fetch(path, options)
	const responseBody = await readJson(response)
	if (!response.ok) {
		throw new Error(readErrorMessage(responseBody, response.status))
	}
	return responseBody
}
