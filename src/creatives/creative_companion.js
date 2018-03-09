import { Creative } from 'creative';

class VASTCreativeCompanion extends Creative {
    constructor(creativeAttributes) {
        super(creativeAttributes);

        this.type = "companion";
        this.variations = [];
    }
}
