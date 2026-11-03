// stand-in for the attribute streams until they land: the open world declares none

/** a stream's type as world.json declares it */
export type StreamType = 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'f16' | 'f32' | 'records';

export interface Declared {
	type: StreamType;
	/** 1 to 4; left out for records */
	components?: number;
}

export class AttributeRegistry {
	/** the stream's id for attribute_word and attribute_record, -1 when the open world lacks it */
	use(name: string, required: boolean): number {
		void name;
		void required;
		return -1;
	}

	release(id: number): void {
		void id;
	}

	/** the stream as the open world declares it */
	declared(name: string): Declared | undefined {
		void name;
		return undefined;
	}
}
