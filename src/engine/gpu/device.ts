export interface Gpu {
	device: GPUDevice;
	/** timestamp-query was granted */
	timestamps: boolean;
	/** the canvas's preferred format */
	format: GPUTextureFormat;
}

/**
 * the device with the adapter's largest buffer and binding sizes and its timestamps when offered;
 * null when the browser has no webgpu or no adapter
 */
export async function requestGpu(): Promise<Gpu | null> {
	if (!navigator.gpu) return null;
	const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
	if (!adapter) return null;
	const timestamps = adapter.features.has('timestamp-query');
	const device = await adapter.requestDevice({
		requiredFeatures: timestamps ? ['timestamp-query'] : [],
		requiredLimits: {
			maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
			maxBufferSize: adapter.limits.maxBufferSize
		}
	});
	return { device, timestamps, format: navigator.gpu.getPreferredCanvasFormat() };
}
