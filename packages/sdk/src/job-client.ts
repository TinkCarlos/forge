import type { JobDetail, JobTarget, JobVersionDetail } from "../../contracts/src/job-api.js";
import type { JobCreateInput, JobPatchInput } from "../../contracts/src/job-definitions.js";
export interface JobTransport { <T>(path: string, options?: { method?: string; body?: unknown; headers?: Record<string,string> }): Promise<T> }
export function createJobClient(request: JobTransport) {
  const path=(id:string)=>`/admin/api/jobs/${encodeURIComponent(id)}`;
  return {
    list: (query: { status?: string; cursor?: string; limit?: string;businessType?:string;orgUnitId?:string } = {}) => request<{items:JobDetail[];nextCursor:string|null}>(`/admin/api/jobs?${new URLSearchParams(Object.entries(query).filter(([key,value])=>["status","cursor","limit","businessType","orgUnitId"].includes(key)&&value!==undefined) as [string,string][]).toString()}`),
    targets: () => request<{items:JobTarget[];nextCursor:string|null}>("/admin/api/job-targets"),
    get: (id:string) => request<JobDetail>(path(id)),
    create: (body:JobCreateInput) => request<JobDetail>("/admin/api/jobs", {method:"POST",body}),
    update: (id:string, revision:number, body:JobPatchInput) => request<JobDetail>(path(id), {method:"PATCH",body,headers:{"If-Match":`"${revision}"`}}),
    publish: (id:string, revision:number) => request<{versionId:string;version:number;revision:number;manifestHash:string}>(`${path(id)}/publish`, {method:"POST",body:{},headers:{"If-Match":`"${revision}"`}}),
    remove: (id:string, revision:number) => request<void>(path(id), {method:"DELETE",headers:{"If-Match":`"${revision}"`}}),
    versions: (id:string, cursor?:string) => request<{items:JobVersionDetail[];nextCursor:string|null}>(`${path(id)}/versions${cursor?`?cursor=${encodeURIComponent(cursor)}`:""}`),
  };
}
