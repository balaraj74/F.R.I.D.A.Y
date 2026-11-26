declare module "node-llama-cpp" {
  export enum LlamaLogLevel {
    error = 0,
  }

  export type LlamaEmbedding = { vector: Float32Array | number[] };

  export type Token = number & { __token?: never };

  export type LlamaEmbeddingContext = {
    getEmbeddingFor: (input: string | Token[]) => Promise<LlamaEmbedding>;
  };

  export type LlamaModel = {
    createEmbeddingContext: () => Promise<LlamaEmbeddingContext>;
    tokenize: (text: string) => Token[];
    readonly trainContextSize: number;
  };

  export type Llama = {
    loadModel: (params: { modelPath: string }) => Promise<LlamaModel>;
  };

  export function getLlama(params: { logLevel: LlamaLogLevel }): Promise<Llama>;
  export function resolveModelFile(modelPath: string, cacheDir?: string): Promise<string>;
}
