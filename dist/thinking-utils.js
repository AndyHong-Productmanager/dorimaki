// Utilities for extracting and matching model variant (thinking level) values
// from the provider.list() API response. Used by model selector and session handler
// to validate variant preferences against what the current model actually supports.
function getModelVariants(model) {
    if (!model || typeof model !== 'object') {
        return undefined;
    }
    const variants = model.variants;
    if (!variants || typeof variants !== 'object') {
        return undefined;
    }
    return variants;
}
export function getThinkingValuesForModel({ providers, providerId, modelId, }) {
    const provider = providers.find((candidateProvider) => {
        return candidateProvider.id === providerId;
    });
    const model = provider?.models?.[modelId];
    const variants = getModelVariants(model);
    if (!variants) {
        return [];
    }
    return Object.keys(variants).filter((variant) => {
        return variant.trim().length > 0;
    });
}
export function matchThinkingValue({ requestedValue, availableValues, }) {
    const normalizedRequestedValue = requestedValue.trim().toLowerCase();
    if (!normalizedRequestedValue) {
        return undefined;
    }
    return availableValues.find((availableValue) => {
        return availableValue.toLowerCase() === normalizedRequestedValue;
    });
}
export function resolveRequestedThinkingVariant({ requestedValue, providers, providerId, modelId, }) {
    return matchThinkingValue({
        requestedValue,
        availableValues: getThinkingValuesForModel({
            providers,
            providerId,
            modelId,
        }),
    });
}
