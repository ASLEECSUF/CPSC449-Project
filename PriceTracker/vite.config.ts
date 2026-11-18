import { defineConfig, loadEnv } from 'vite'

export default defineConfig(function ({ mode }) {
	const env = loadEnv(mode, process.cwd(), '')
	let port = '3000'
	if (env.PORT) {
		port = env.PORT
	}

	return {
		server: {
			proxy: {
				'/api': `http://localhost:${port}`,
			},
		},
	}
})
