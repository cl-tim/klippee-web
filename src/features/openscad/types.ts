export type OpenScadParameterValue = string | number | boolean;
export type CadEngine = "build123d" | "openscad";

export type OpenScadParameterOption = {
  label: string;
  value: OpenScadParameterValue;
};

export type OpenScadParameter = {
  defaultValue: OpenScadParameterValue;
  description?: string;
  group: string;
  key: string;
  label: string;
  max?: number;
  min?: number;
  options?: OpenScadParameterOption[];
  step?: number;
  type: "boolean" | "number" | "select" | "text";
};

export type OpenScadSourceFile = {
  conversion?: {
    bodyCount: number;
    duration: number;
    recognizedBodyCount: number;
    referenceBodyCount: number;
    sourceName: string;
    triangleCount: number;
    vertexCount: number;
  };
  engine?: CadEngine;
  name: string;
  parameters?: OpenScadParameter[];
  plan?: Record<string, unknown>;
  source: string;
};

export type OpenScadRenderMode = "export" | "preview";
