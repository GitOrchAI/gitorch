import React, { useState, useRef } from 'react'
import { useLanguage } from '../../LanguageContext'

interface UploadDeAnexosProps {
  arquivos: File[]
  onChange: (arquivos: File[]) => void
}

const MAX_SIZE = 5 * 1024 * 1024 // 5MB limit client-side
const ALLOWED_EXTENSIONS = ['.pdf', '.md', '.doc', '.docx']

export function UploadDeAnexos({ arquivos, onChange }: UploadDeAnexosProps) {
  const { t } = useLanguage()
  const [arrastando, setArrastando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const processarArquivos = (files: FileList | File[]) => {
    setErro(null)
    const novos: File[] = []

    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()

      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setErro(t('upload.acceptedFormats'))
        return
      }
      if (f.size > MAX_SIZE) {
        setErro(t('upload.sizeExceeded'))
        return
      }
      novos.push(f)
    }

    if (novos.length > 0) {
      onChange([...arquivos, ...novos])
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setArrastando(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setArrastando(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setArrastando(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processarArquivos(e.dataTransfer.files)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processarArquivos(e.target.files)
    }
    // reset input value so the same file can be selected again if removed
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  const removerArquivo = (index: number) => {
    const novos = [...arquivos]
    novos.splice(index, 1)
    onChange(novos)
  }

  const tamanhoLegivel = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    const kb = bytes / 1024
    if (kb < 1024) return kb.toFixed(1) + ' KB'
    const mb = kb / 1024
    return mb.toFixed(1) + ' MB'
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        tabIndex={0}
        style={{
          border: arrastando ? '2px dashed var(--gl-accent)' : '2px dashed var(--gl-hair-strong)',
          borderRadius: 8,
          padding: 24,
          textAlign: 'center',
          cursor: 'pointer',
          backgroundColor: arrastando ? 'var(--gl-surface-2)' : 'transparent',
          transition: 'all 0.2s ease',
        }}
        role="button"
        aria-label={t('upload.dropOrClick')}
      >
        <input
          type="file"
          multiple
          ref={inputRef}
          style={{ display: 'none' }}
          onChange={handleChange}
          accept=".pdf,.md,.doc,.docx"
        />
        <div style={{ color: 'var(--gl-ink)', fontWeight: 500, marginBottom: 4 }}>
          {t('upload.dropOrClick')}
        </div>
        <div style={{ color: 'var(--gl-muted)', fontSize: 13 }}>{t('upload.acceptedFormats')}</div>
      </div>

      {erro && <div style={{ color: 'var(--gl-sev)', fontSize: 13.5, marginTop: 8 }}>{erro}</div>}

      {arquivos.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {arquivos.map((f, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                border: '1px solid var(--gl-hair)',
                borderRadius: 6,
                backgroundColor: 'var(--gl-surface)',
                fontSize: 13,
              }}
            >
              <div
                style={{
                  flex: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 150,
                }}
                title={f.name}
              >
                {f.name}
              </div>
              <div style={{ color: 'var(--gl-muted)', fontSize: 11 }}>{tamanhoLegivel(f.size)}</div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  removerArquivo(i)
                }}
                className="pn-btn g sm"
                style={{ padding: '2px 6px', minWidth: 'auto', marginLeft: 4 }}
                aria-label={t('upload.removeAttachment')}
                title={t('upload.removeAttachment')}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
