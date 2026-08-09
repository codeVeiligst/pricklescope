import type { AuthProviders, AuthSession, LoginRequest } from '@pricklescope/contracts'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { api, ApiClientError } from './api.js'

interface AuthContextValue {
  session: AuthSession | null
  providers: AuthProviders | null
  loading: boolean
  login: (request: LoginRequest) => Promise<void>
  logout: () => Promise<void>
  refreshProviders: () => Promise<void>
  csrfToken: string | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [providers, setProviders] = useState<AuthProviders | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    void Promise.all([
      api.providers(),
      api.session().catch((error: unknown) => {
        if (error instanceof ApiClientError && error.status === 401) return null
        throw error
      }),
    ])
      .then(([providerResult, sessionResult]) => {
        if (!active) return
        setProviders(providerResult)
        setSession(sessionResult)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const login = useCallback(async (request: LoginRequest) => {
    setSession(await api.login(request))
  }, [])

  const logout = useCallback(async () => {
    if (session?.csrfToken) await api.logout(session.csrfToken)
    setSession(null)
  }, [session])

  const refreshProviders = useCallback(async () => {
    setProviders(await api.providers())
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      providers,
      loading,
      login,
      logout,
      refreshProviders,
      csrfToken: session?.csrfToken ?? null,
    }),
    [session, providers, loading, login, logout, refreshProviders],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
