module.exports = {
	apps: [
		{
			name: "ezdyndns",
			script: "backend/index.js",
			interpreter: "bun",
			cwd: "/app",
			instances: 1,
			// NEVER cluster this: the scheduler must be a single process, or every
			// replica would race to update the same DNS records.
			exec_mode: "fork",
			autorestart: true,
			max_restarts: 10,
			restart_delay: 5000,
			env: {
				NODE_ENV: "production",
				EZDYNDNS_HOST: "0.0.0.0",
			},
		},
	],
};
