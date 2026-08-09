import type { Source } from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, LoaderCircle, Network, Plus, Search } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { FormError, Modal } from '../components/modal.js'
import { formString } from '../form.js'
import { statusTone } from '../labels.js'
import { useDocumentTitle } from '../hooks.js'

function SourceRow({ source }: { source: Source }) {
  return (
    <Link className="device-row" to={`/devices/${source.id}`} role="row">
      <span className="device-identity" role="cell">
        <span className="device-avatar">
          <Network size={17} />
        </span>
        <span>
          <strong>{source.systemName ?? source.name}</strong>
          <small>
            {source.target}:{source.port}
          </small>
        </span>
      </span>
      <span role="cell">
        <StatusPill tone={statusTone(source.status)}>{source.status.replace('_', ' ')}</StatusPill>
      </span>
      <span className="table-copy" role="cell">
        {source.site?.name ?? 'Unassigned'}
      </span>
      <span className="table-copy" role="cell">
        {source.collector === 'telegraf' ? 'Telegraf' : 'Grafana Alloy'}
      </span>
      <span className="table-copy device-row__last" role="cell">
        {source.lastInventoryAt
          ? new Date(source.lastInventoryAt).toLocaleString()
          : 'Not discovered'}
        <ArrowRight size={15} aria-hidden="true" />
      </span>
    </Link>
  )
}

export function DevicesPage() {
  useDocumentTitle('Devices')
  const queryClient = useQueryClient()
  const { session, csrfToken } = useAuth()
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const canOperate = session?.user.role !== 'viewer'
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.sources() })
  const sites = useQuery({ queryKey: ['sites'], queryFn: api.sites, enabled: canOperate })
  const credentials = useQuery({
    queryKey: ['snmp-credentials'],
    queryFn: api.snmpCredentials,
    enabled: canOperate,
  })
  const profiles = useQuery({
    queryKey: ['polling-profiles'],
    queryFn: api.pollingProfiles,
    enabled: canOperate,
  })
  const collectors = useQuery({
    queryKey: ['collector-capabilities'],
    queryFn: api.collectorCapabilities,
    enabled: canOperate,
  })
  const create = useMutation({
    mutationFn: (request: Parameters<typeof api.createSource>[0]) =>
      api.createSource(request, csrfToken!),
    onSuccess: async () => {
      setAdding(false)
      await queryClient.invalidateQueries({ queryKey: ['sources'] })
    },
  })
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return sources.data?.sources ?? []
    return (sources.data?.sources ?? []).filter((source) =>
      [source.name, source.target, source.systemName, source.site?.name, ...source.tags]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    )
  }, [search, sources.data])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    create.mutate({
      name: formString(values, 'name'),
      target: formString(values, 'target'),
      port: Number(values.get('port')),
      transport: formString(values, 'transport') as 'udp4' | 'udp6',
      siteId: formString(values, 'siteId') || null,
      credentialId: formString(values, 'credentialId'),
      profileId: formString(values, 'profileId'),
      collectorSelection: formString(values, 'collectorSelection') as 'auto' | 'telegraf' | 'alloy',
      tags: formString(values, 'tags')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
  }

  const readyToAdd =
    (credentials.data?.credentials.length ?? 0) > 0 && (profiles.data?.profiles.length ?? 0) > 0

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Devices</ScreenReaderHeading>
      <section className="content-toolbar" aria-label="Device tools">
        <div className="toolbar-search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search devices"
            placeholder="Search name, address, site, or tag"
          />
        </div>
        {canOperate ? (
          <Button icon={<Plus size={17} />} onClick={() => setAdding(true)}>
            Add device
          </Button>
        ) : null}
      </section>

      <section className="panel table-panel" aria-label="Device inventory">
        <div className="table-meta">
          <div>
            <strong>
              {filtered.length} {filtered.length === 1 ? 'device' : 'devices'}
            </strong>
            <span>
              Across {new Set(filtered.map((source) => source.site?.id).filter(Boolean)).size} sites
            </span>
          </div>
          {sources.isFetching ? <LoaderCircle className="spin muted-icon" size={18} /> : null}
        </div>
        <div className="device-table" role="table" aria-label="Devices">
          <div className="device-table__head" role="row">
            <span role="columnheader">Device</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Site</span>
            <span role="columnheader">Collector</span>
            <span role="columnheader">Last inventory</span>
          </div>
          {sources.isLoading ? (
            <div className="empty-table">
              <LoaderCircle className="spin muted-icon" size={24} />
            </div>
          ) : sources.error ? (
            <div className="empty-table">
              <FormError error={sources.error} />
            </div>
          ) : filtered.length ? (
            filtered.map((source) => <SourceRow key={source.id} source={source} />)
          ) : (
            <div className="empty-table">
              <div className="empty-table__icon">
                <Network size={25} />
              </div>
              <strong>{search ? 'No devices match that search' : 'Your inventory is ready'}</strong>
              <p>
                {search
                  ? 'Try a device name, address, site, or tag.'
                  : 'Add a hostname or IP, select an SNMP credential, then preview discovery before applying it.'}
              </p>
              {!search && canOperate ? (
                <Button size="small" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                  Add first device
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <Modal
        title="Add a device"
        description="Choose how PrickleScope should reach and inventory it."
        open={adding}
        onClose={() => setAdding(false)}
      >
        {!readyToAdd ? (
          <div className="prerequisite-note">
            Add an SNMP credential before creating a device. A polling profile is already provided
            by default.
          </div>
        ) : null}
        <form className="resource-form" onSubmit={submit}>
          <div className="form-grid">
            <label className="field field--wide">
              <span>Name</span>
              <input name="name" required maxLength={128} placeholder="Core switch" />
            </label>
            <label className="field">
              <span>Hostname or IP</span>
              <input name="target" required maxLength={253} placeholder="10.20.0.1" />
            </label>
            <label className="field field--compact">
              <span>Port</span>
              <input name="port" type="number" min={1} max={65535} defaultValue={161} required />
            </label>
            <label className="field">
              <span>Transport</span>
              <select name="transport" defaultValue="udp4">
                <option value="udp4">UDP / IPv4</option>
                <option value="udp6">UDP / IPv6</option>
              </select>
            </label>
            <label className="field">
              <span>Site</span>
              <select name="siteId" defaultValue="">
                <option value="">Unassigned</option>
                {sites.data?.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.path.map((part) => part.name).join(' / ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>SNMP credential</span>
              <select name="credentialId" required defaultValue="">
                <option value="" disabled>
                  Select credential
                </option>
                {credentials.data?.credentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.name} · v{credential.version}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Polling profile</span>
              <select name="profileId" required defaultValue="">
                <option value="" disabled>
                  Select profile
                </option>
                {profiles.data?.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.intervalSeconds}s
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Collector</span>
              <select name="collectorSelection" defaultValue="auto">
                <option value="auto">Auto · Telegraf recommended</option>
                {collectors.data?.capabilities.map((collector) => (
                  <option
                    key={collector.kind}
                    value={collector.kind}
                    disabled={!collector.available}
                  >
                    {collector.label}
                    {collector.available ? '' : ' · unavailable'}
                  </option>
                ))}
              </select>
              <small>Alloy SNMP becomes available after normalization support lands.</small>
            </label>
            <label className="field field--wide">
              <span>Tags</span>
              <input name="tags" placeholder="core, production, network" />
              <small>Comma-separated</small>
            </label>
          </div>
          <FormError error={create.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!readyToAdd || create.isPending}>
              {create.isPending ? 'Adding…' : 'Add device'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
