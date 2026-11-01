const text = (maxLength:number,minLength=0) => ({type:"string",maxLength,minLength}) as const;
const properties = { name:text(128,1),description:text(1024),status:{type:"string",maxLength:16,enum:["active","disabled"]},permissions:{type:"array",maxItems:200,uniqueItems:true,items:text(64,1)} } as const;
const key = {...text(32,1),pattern:"^[a-z][a-z0-9_]{0,31}$"} as const;
export const ROLE_SCHEMAS = {
  roleCreate:{body:{type:"object",additionalProperties:false,properties:{key,...properties},required:["key","name","permissions"]}},
  rolePatch:{body:{type:"object",additionalProperties:false,properties}},
  roleCopy:{body:{type:"object",additionalProperties:false,properties:{key,name:properties.name,description:properties.description},required:["key","name"]}},
} as const;
export interface RoleDto {
  id:string; key:string; name:string; description:string; status:string; builtin:boolean; revision:number;
  permissions:string[]; can_manage:boolean; can_copy:boolean; can_reset:boolean; references?:Record<string,number>;
}
