import { GRAFANA_DASHBOARDS, type Site } from '@pricklescope/contracts'
import { Button, ScreenReaderHeading } from '@pricklescope/ui'
import { BarChart3, Building2, FolderTree, MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type CSSProperties, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { grafanaUrl } from '../grafana.js'
import { useConfirm } from '../components/confirm.js'
import { FormError, Modal } from '../components/modal.js'
import { formString } from '../form.js'
import { useDocumentTitle } from '../hooks.js'

type SiteDepthStyle = CSSProperties & { '--site-depth': number }

function sitePath(site: Site): string {
  return site.path.map((part) => part.name).join(' / ')
}

export function SitesPage() {
  const { confirm, confirmDialog } = useConfirm()
  useDocumentTitle('Sites')
  const { session, csrfToken } = useAuth()
  const canOperate = session?.user.role !== 'viewer'
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['sites'], queryFn: api.sites })
  const grafana = useQuery({ queryKey: ['grafana'], queryFn: api.grafana })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Site | null>(null)
  const [initialParentId, setInitialParentId] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (request: { name: string; description?: string; parentId: string | null }) =>
      editing
        ? api.updateSite(editing.id, request, csrfToken!)
        : api.createSite(request, csrfToken!),
    onSuccess: async () => {
      setDialogOpen(false)
      setEditing(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sites'] }),
        queryClient.invalidateQueries({ queryKey: ['sources'] }),
      ])
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSite(id, csrfToken!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sites'] }),
  })

  function open(site: Site | null, parentId: string | null = null) {
    setEditing(site)
    setInitialParentId(site?.parentId ?? parentId)
    save.reset()
    setDialogOpen(true)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const description = formString(values, 'description').trim()
    save.mutate({
      name: formString(values, 'name'),
      ...(description ? { description } : {}),
      parentId: formString(values, 'parentId') || null,
    })
  }

  const parentOptions = (query.data?.sites ?? []).filter(
    (site) => !editing || !site.path.some((part) => part.id === editing.id),
  )

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Sites</ScreenReaderHeading>
      <section className="resource-toolbar" aria-label="Site tools">
        <div>
          <MapPin size={18} />
          <span>
            <strong>{query.data?.sites.length ?? 0}</strong> locations ·{' '}
            <strong>
              {query.data?.sites.filter((site) => site.parentId === null).length ?? 0}
            </strong>{' '}
            top level
          </span>
        </div>
        {canOperate ? (
          <Button icon={<Plus size={17} />} onClick={() => open(null)}>
            Add site
          </Button>
        ) : null}
      </section>
      <FormError error={query.error ?? remove.error} />
      {query.data?.sites.length ? (
        <section className="site-tree" aria-label="Site hierarchy">
          {query.data.sites.map((site) => (
            <article
              className="site-tree__row"
              key={site.id}
              style={{ '--site-depth': site.depth } as SiteDepthStyle}
            >
              <div className="site-tree__branch" aria-hidden="true">
                <span />
                <Building2 size={18} />
              </div>
              <div className="site-tree__copy">
                <strong>{site.name}</strong>
                <small>
                  {site.depth
                    ? site.path
                        .slice(0, -1)
                        .map((part) => part.name)
                        .join(' / ')
                    : 'Top-level location'}
                </small>
                {site.description ? <p>{site.description}</p> : null}
              </div>
              <div className="site-tree__counts">
                <strong>{site.totalSourceCount}</strong>
                <span>
                  {site.sourceCount === site.totalSourceCount
                    ? 'devices'
                    : `${site.sourceCount} here`}
                </span>
              </div>
              {canOperate || grafana.data?.status === 'active' ? (
                <div className="resource-card__actions site-tree__actions">
                  {grafana.data?.status === 'active' ? (
                    <a
                      className="icon-button"
                      href={grafanaUrl(GRAFANA_DASHBOARDS.fleet.uid, {
                        site_id: query.data.sites
                          .filter((candidate) => candidate.path.some((part) => part.id === site.id))
                          .map((candidate) => candidate.id),
                      })}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Graph ${sitePath(site)} and child locations`}
                      title="Open subtree dashboard"
                    >
                      <BarChart3 size={16} />
                    </a>
                  ) : null}
                  {canOperate ? (
                    <>
                      <button
                        className="icon-button"
                        onClick={() => open(null, site.id)}
                        aria-label={`Add a location below ${site.name}`}
                        title="Add child location"
                      >
                        <Plus size={16} />
                      </button>
                      <button
                        className="icon-button"
                        onClick={() => open(site)}
                        aria-label={`Edit ${sitePath(site)}`}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="icon-button danger-icon"
                        disabled={site.childCount > 0}
                        title={
                          site.childCount ? 'Move or remove child locations first' : 'Remove site'
                        }
                        onClick={() => {
                          confirm({
                            title: `Remove ${sitePath(site)}?`,
                            body: 'Devices at this location become unassigned. They keep their history.',
                            confirmLabel: 'Remove location',
                            destructive: true,
                            onConfirm: () => remove.mutate(site.id),
                          })
                        }}
                        aria-label={`Remove ${sitePath(site)}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ) : !query.isLoading ? (
        <div className="panel resource-empty">
          <FolderTree size={25} />
          <strong>No sites yet</strong>
          <span>Build a hierarchy such as campus, building, floor, and room.</span>
        </div>
      ) : null}

      <Modal
        title={editing ? 'Edit site' : initialParentId ? 'Add child location' : 'Add a site'}
        description="Devices can live at any level. Moving a site also moves its full subtree."
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      >
        <form className="resource-form" onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input
              name="name"
              required
              maxLength={128}
              defaultValue={editing?.name}
              placeholder="Brussels office"
            />
          </label>
          <label className="field">
            <span>Parent location</span>
            <select name="parentId" defaultValue={initialParentId ?? ''}>
              <option value="">Top level</option>
              {parentOptions.map((site) => (
                <option key={site.id} value={site.id}>
                  {sitePath(site)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Description</span>
            <textarea
              name="description"
              maxLength={1000}
              defaultValue={editing?.description ?? ''}
              placeholder="Optional context for operators"
            />
          </label>
          <FormError error={save.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save site'}
            </Button>
          </div>
        </form>
      </Modal>
      {confirmDialog}
    </div>
  )
}
