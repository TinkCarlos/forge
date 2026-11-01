import {useCan} from '@/hooks/use-can'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createJobClient } from '@forge/sdk/jobs'
import { jobCacheIdentity } from '../cache-identity'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import type { JobCreate, JobPatch } from '../../../../../../packages/contracts/src/job-definitions'
export const jobClient = createJobClient(api)
export function useJobIdentity() { return useAuthStore(state=>jobCacheIdentity(state.session)) }
export function useJobs(status?: string, cursor?: string, businessType?:string, orgUnitId?:string) {
  const identity=useJobIdentity()
  return useQuery({ queryKey: ['jobs', identity, status, cursor,businessType,orgUnitId], queryFn: () => jobClient.list({ status: status || undefined, cursor: cursor || undefined,businessType:businessType?.trim()||undefined,orgUnitId:orgUnitId||undefined }) })
}
export function useJobSave() {
  const cache=useQueryClient()
  return useMutation({ mutationFn: (input: { id?: string; revision?: number; body: JobCreate | JobPatch }) => input.id ? jobClient.update(input.id, input.revision!, input.body) : jobClient.create(input.body as JobCreate), onSuccess: async () => { await cache.invalidateQueries({queryKey:['jobs']}) } })
}

export function useJobOrganizations() {
 const identity=useJobIdentity(),allowed=useCan('org.view')
 return useQuery({queryKey:['job-organizations',identity],enabled:allowed,queryFn:()=>api<{items:{id:string;name:string;status:string}[]}>('/admin/api/org-units')})
}
