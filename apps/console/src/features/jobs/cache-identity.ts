import type { Session } from '@/lib/api'
export function jobCacheIdentity(session:Session|null):string{return JSON.stringify([session?.user,session?.permissions,session?.dataScope])}
