import { Problem, text } from './domain.js';
export function vehicleDetails(input:Record<string,unknown>) {
  const optional=(value:unknown,label:string,max:number)=>value===undefined||value===null||value===''?null:text(value,label,max);
  const modelName=optional(input.modelName,'차종',40),licensePlate=optional(input.licensePlate,'차량번호',20);
  if(licensePlate&&!/^[가-힣A-Z0-9 -]+$/u.test(licensePlate))throw new Problem(400,'INVALID_VEHICLE_PLATE','차량번호를 확인해 주세요.');
  return {modelName,licensePlate,modelKey:modelName?.replace(/\s/g,'').toLowerCase()==='아이오닉5'?'ioniq5':null};
}
