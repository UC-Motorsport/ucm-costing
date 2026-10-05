export interface SystemDefinition {
  code: string;
  name: string;
}

export const systemDefinitions: SystemDefinition[] = [
  { code: "BR", name: "Brakes" },
  { code: "DR", name: "Drivetrain" },
  { code: "CH", name: "Chassis" },
  { code: "AD", name: "Aerodynamics" },
  { code: "EL", name: "Electrical" },
  { code: "MS", name: "Miscellaneous" },
  { code: "ST", name: "Steering" },
  { code: "SU", name: "Suspension" },
  { code: "WT", name: "Wheels and Tyres" },
];

export function systemName(code: string): string {
  return (
    systemDefinitions.find((system) => system.code === code)?.name ?? code
  );
}
