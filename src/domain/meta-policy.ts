export const museSparkModel = "muse-spark-1.3"

export const isMuseModel = (model: { readonly provider: string; readonly model: string } | undefined): boolean =>
  model?.provider === "meta" && model.model === museSparkModel
