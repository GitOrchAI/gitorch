'use client'

import React, { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLanguage } from '../../../LanguageContext'
import { API_BASE_URL } from '../../../lib/api'

function ClaimInvitationContent() {
  const { t } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const [status, setStatus] = useState<'loading' | 'error' | 'success'>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [projectData, setProjectData] = useState<{
    projects?: { name: string }[]
    owner?: { githubLogin: string }
  } | null>(null)
  const [claiming, setClaiming] = useState(false)

  useEffect(() => {
    if (!token) {
      setTimeout(() => setStatus('error'), 0)
      setTimeout(() => setErrorMessage(t('invitation.invalidToken')), 0)
      return
    }

    const loadInvitation = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/invites/claim/${token}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        })

        if (!response.ok) {
          throw new Error('Failed to load invitation')
        }

        const data = await response.json()
        setTimeout(() => setProjectData(data), 0)
        setTimeout(() => setStatus('success'), 0)
      } catch (err) {
        setTimeout(() => setStatus('error'), 0)
        setTimeout(() => setErrorMessage(t('invitation.invalidToken')), 0)
      }
    }

    loadInvitation()
  }, [token, t])

  const handleClaim = async () => {
    setClaiming(true)
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/invites/claim/${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
      if (!response.ok) {
        throw new Error('Failed to claim invitation')
      }

      router.push('/setup')
    } catch (err) {
      setTimeout(() => setErrorMessage(t('invitation.invalidToken')), 0)
      setTimeout(() => setStatus('error'), 0)
    } finally {
      setClaiming(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        flexDirection: 'column',
      }}
    >
      {status === 'loading' && <h2>{t('invitation.validateTitle')}</h2>}
      {status === 'error' && <h2 style={{ color: 'red' }}>{errorMessage}</h2>}
      {status === 'success' && projectData && (
        <div style={{ textAlign: 'center' }}>
          <h2>
            You have been invited to join the project:{' '}
            {projectData.projects?.[0]?.name || 'a project'}
          </h2>
          <p>By {projectData.owner?.githubLogin}</p>
          <button
            onClick={handleClaim}
            disabled={claiming}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              cursor: 'pointer',
              backgroundColor: '#0070f3',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              marginTop: '20px',
            }}
          >
            {claiming ? 'Processing...' : t('invitation.acceptInvitation')}
          </button>
        </div>
      )}
    </div>
  )
}

export default function ClaimInvitationPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ClaimInvitationContent />
    </Suspense>
  )
}
