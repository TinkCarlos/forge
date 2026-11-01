import {isEntityId} from '@/lib/entity-id'
import { createFileRoute } from '@tanstack/react-router'
import { Jobs } from '@/features/jobs'
import { RouteError } from '@/features/errors/route-error'
import { guard } from '@/lib/route-guard'
export const Route=createFileRoute('/_authenticated/jobs/')({
  beforeLoad:guard('job.view'),errorComponent:RouteError,component:Jobs,
  validateSearch:(search:Record<string,unknown>)=>({status:search.status==='active'||search.status==='disabled'?search.status:'',cursor:typeof search.cursor==='string'?search.cursor:'',businessType:typeof search.businessType==='string'?search.businessType:'',orgUnitId:isEntityId(search.orgUnitId)?search.orgUnitId:''}),
})
