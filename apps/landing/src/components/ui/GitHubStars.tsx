import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Github, Star } from 'lucide-react'

interface GitHubStarsProps {
  className?: string
  owner?: string
  repo?: string
}

export function GitHubStars({ className, owner = 'loureng', repo = 'gitorch' }: GitHubStarsProps) {
  useTranslation()
  const [stars, setStars] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchStars = async () => {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: { Accept: 'application/vnd.github.v3+json' },
        })
        if (res.ok) {
          const data = await res.json()
          setStars(data.stargazers_count)
        }
      } catch {
        // Silently fail - stars are optional
      } finally {
        setLoading(false)
      }
    }

    fetchStars()
    const interval = setInterval(fetchStars, 5 * 60 * 1000) // Refresh every 5 min
    return () => clearInterval(interval)
  }, [owner, repo])

  if (loading) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 dark:bg-dark-800/50',
          className
        )}
      >
        <div className="w-10 h-4 bg-dark-200 dark:bg-dark-700 rounded animate-pulse" />
      </div>
    )
  }

  if (stars === null) return null

  return (
    <a
      href={`https://github.com/${owner}/${repo}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-lg',
        'bg-white/10 dark:bg-dark-800/50',
        'border border-white/10 dark:border-dark-700',
        'hover:bg-white/20 dark:hover:bg-dark-700',
        'text-sm font-medium text-dark-600 dark:text-dark-300',
        'transition-all duration-200',
        className
      )}
      aria-label={`GitHub stars: ${stars.toLocaleString()}`}
    >
      <Github className="w-4 h-4 text-dark-500 dark:text-dark-400" />
      <Star className="w-4 h-4 text-yellow-500" />
      <span className="font-mono tabular-nums">{stars.toLocaleString()}</span>
    </a>
  )
}
