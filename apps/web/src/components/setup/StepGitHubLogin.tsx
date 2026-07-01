import React from 'react'

interface StepGitHubLoginProps {
  apiBaseUrl: string
}

export default function StepGitHubLogin({ apiBaseUrl }: StepGitHubLoginProps) {
  const handleLogin = () => {
    window.location.href = `${apiBaseUrl}/api/v1/auth/github`
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-6">
      <div className="w-16 h-16 bg-[rgba(124,58,237,0.1)] text-[#7c3aed] rounded-full flex items-center justify-center mb-6 glow-border">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
          <path d="M9 18c-4.51 2-5-2-7-2" />
        </svg>
      </div>

      <h2 className="text-3xl font-bold mb-4">Conecte sua conta do GitHub</h2>
      <p className="text-[var(--text-secondary)] mb-8 max-w-md">
        Para ler seus repositórios e configurar os agentes do GitOrch, precisamos de autorização na
        sua conta GitHub.
      </p>

      <button
        onClick={handleLogin}
        className="bg-white text-black px-8 py-4 rounded-full font-bold flex items-center gap-3 hover:scale-105 transition-all cursor-pointer shadow-[0_0_30px_rgba(255,255,255,0.15)]"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.197 22 16.442 22 12.017 22 6.484 17.522 2 12 2z"
          />
        </svg>
        Entrar com o GitHub
      </button>
    </div>
  )
}
