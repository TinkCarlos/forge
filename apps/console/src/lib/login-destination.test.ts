import {expect,it} from 'vitest'
import {defaultLanding,loginDestination} from './permissions'
it('selects actual accessible pages for roles without Agent access',()=>{
  expect(defaultLanding(['role.view'])).toBe('/#users/roles');expect(defaultLanding(['user.view'])).toBe('/#users');expect(defaultLanding(['model.view'])).toBe('/#models');expect(defaultLanding(['approval.view'])).toBe('/approvals');expect(defaultLanding(['*'])).toBe('/agents')
})
it('preserves authorized deep links and redirects an unauthorized known destination',()=>{
  expect(loginDestination(['user.view'],'/#users/roles')).toBe('/#users')
  expect(loginDestination(['approval.view'],'/approvals?page=3')).toBe('/approvals?page=3');expect(loginDestination(['role.view'],'/agents')).toBe('/#users/roles');expect(loginDestination(['role.view'],'/#users')).toBe('/#users/roles');expect(loginDestination(['agent.view'],'/#agents/agt_id')).toBe('/#agents/agt_id');expect(loginDestination(['user.view'],'/')).toBe('/#users');expect(loginDestination(['agent.view'],'/unknown')).toBe('/unknown')
})

it('routes job-only users to their permitted Job page',()=>{expect(defaultLanding(['job.view'])).toBe('/jobs');expect(loginDestination(['job.view'],'/agents')).toBe('/jobs');expect(loginDestination(['agent.view'],'/jobs')).toBe('/agents')})
