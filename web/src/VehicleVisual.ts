// Only local, reviewed assets are allowed. Profile names and display badges are independent.
export const vehicleVisuals={
  ioniq5:{name:'아이오닉 5',image:import.meta.env.BASE_URL+'vehicles/ioniq5.png?v=vehicle-badge-v2'},
} as const;
export function vehicleVisual(modelKey:string|null|undefined){
  return modelKey && Object.hasOwn(vehicleVisuals,modelKey)?vehicleVisuals[modelKey as keyof typeof vehicleVisuals]:null;
}

// The current vehicle's presentation badge is independent of optional profile metadata.
export function vehicleBadge(modelKey:string|null|undefined){return vehicleVisual(modelKey)??{name:'우리 차',image:vehicleVisuals.ioniq5.image};}
