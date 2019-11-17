//@ts-check

import "../grid-chen/webcomponent.js"
import { createView } from "../grid-chen/matrixview.js";
import { Range } from "../grid-chen/selection.js";
import {
    NumberConverter,
    DateTimeStringConverter,
    FullDateStringConverter,
    DatePartialTimeStringConverter,
    StringConverter
} from "../grid-chen/converter.js";
import { registerGlobalTransactionManager, applyJSONPatch } from "../grid-chen/utils.js";


/**
 * Example:
 *      getValueByPointer({definitions:{foobar: 1}}, '#/definitions/foobar')
 *      -> 1
 * @param {object} obj
 * @param {string} pointer
 * @returns {object}
 */
function getValueByPointer(obj, pointer) {
    return pointer.substr(2).split('/').reduce(((res, prop) => res[prop]), obj);
}

/**
 TypedValue decorates a (possibly nested) JavaScript value and its type (via schema).
 It also makes the type graph navigable from child to parent and from parent to child.

 ------------------------              ------------------            ---------------
 obj    | {foo: {bar: 'foobar'}} |   parent   | {bar: 'foobar'}} |  parent  | 'undefined     |
 key    | ''                     |     <-     | 'foo'            |    <-    | 'bar'         |
 ------------------------              ------------------            ---------------
 */

/**
 * @implements {FormChenNS.Graph}
 */
class Graph {
    /**
     * @param {GridChenNS.JSONSchema} rootSchema
     */
    constructor(rootSchema) {
        this.rootSchema = rootSchema;
        /** @type{{[key: string]: TypedValue}} */
        //this.nodesByPath = {};
        /** @type{FormChenNS.TypedValue[]} */
        this.nodes = [];
        this.nodesById = {};
    }

    /**
     * @param {FormChenNS.TypedValue} node 
     */
    add(node) {
        this.nodes.push(node);
        this.nodesById[node.id] = node;
    }

    // /**
    //  * @param {string} path 
    //  * @returns {FormChenNS.TypedValue}
    //  */
    // _getNodeByPath(path) {
    //     for (const node of this.nodes) {
    //         if (node.path === path) {
    //             return node
    //         }
    //     }
    //     return null;
    // }

    /**
     * @param {number} id 
     * @returns {FormChenNS.TypedValue}
     */
    getNodeById(id) {
        return this.nodesById[id]
    }

    /**
      * TODO: Move this to createFormChen()
      * @param {GridChenNS.ColumnSchema} schema
      * @param {string} path
      * @returns {GridChenNS.ColumnSchema}
      */
    resolveSchema(schema, path) {
        if ('$ref' in schema) {
            const refSchema = getValueByPointer(this.rootSchema, schema['$ref']);
            if (!refSchema) {
                throw new Error('Undefined $ref at ' + path);
            }
            return refSchema
        }
        return schema
    }
}

let idSequence = 0;

/** @implements{FormChenNS.TypedValue} */
export class TypedValue {

    /**
     * @param {FormChenNS.Graph} graph
     * @param {string} relId
     * @param {string | number} key
     * @param {GridChenNS.ColumnSchema} schema
     * @param {FormChenNS.ProxyNode} parent
     */
    constructor(graph, relId, key, schema, parent) {
        if (!parent && relId === '') {
            this.id = schema.pathPrefix;
        } else {
            this.id = relId[0]==='/'?relId:((parent?parent.id:'') + '/' + String(relId));
        }
        this.graph = graph;
        this.parent = parent;
        this.key = key;
        if (this.key !== undefined) {
            this.path = (this.parent?this.parent.path + '/' + key:String(key));
        }
        if (typeof schema.readOnly === 'boolean') {
            this.readOnly = schema.readOnly
        } else if (parent) {
            // Inherit read only.
            this.readOnly = parent.readOnly;
        }
        this.schema = schema;
        if (schema.title == null) {
            this.title = this.schema.title || String(relId);
        } else {
            this.title = schema.title;
        }

        if (parent) {
            parent.children.push(this);
        }

        graph.add(this);
    }

    // /**
    //  * @returns {string}
    //  */
    // get path() {
    //     /** @type{FormChenNS.TypedValue} */
    //     let n = this;
    //     let parts = [];
    //     while (n) {
    //         parts.unshift(String(n.key));
    //         n = n.parent;
    //     }
    //     return parts.join('/');
    // }

    /**
     * @returns {FormChenNS.TypedValue}
     */
    get root() {
        /** @type{FormChenNS.TypedValue} */
        let n = this;
        while (n.parent) {
            n = n.parent;
        }
        return n;
    }

    getValue() {
        if (this.parent && this.parent.obj) {
            return this.parent.obj[this.key]
        }
        return undefined;
    }

    /**
     * @param {?} obj
     * @returns {GridChenNS.Patch}
     */
    setValue(obj) {
        let oldValue = this.getValue();

        /** @type {GridChenNS.Patch} */
        const patch =  {
            apply: (patch) => {
                for (let op of patch.operations) {
                    let node = this.graph.getNodeById(op.nodeId);
                    const detailNode = /** @type{FormChenNS.DetailNode} */ (node.root);
                    if (detailNode.grid) {
                        const rowIndex = patch.details.selectedRange.rowIndex;
                        detailNode.setRowIndex(rowIndex);
                        detailNode.grid.select(patch.details.selectedRange);
                    }
                    node._setValue(op.value);
                }
            },
            operations: [],
            pathPrefix: this.graph.rootSchema.pathPrefix || ''
        };

        const detailNode = /** @type{FormChenNS.DetailNode} */ (this.root);
        if (detailNode.grid) {
            patch.details = {selectedRange: /**@type{FormChenNS.DetailNode}*/detailNode.grid.selectedRange};
        }

        if (obj == oldValue) {
            return patch
        }

        /** @type{GridChenNS.JSONPatchOperation} */
        let op;
        if (obj == null) {
            op = { op: 'remove', path: this.path, oldValue };
        } else if (oldValue == null) {
            patch.operations.push(...this.createPathToRoot(obj));
            op = { op: 'add', path: this.path, value: obj };
        } else {
            op = { op: 'replace', path: this.path, value: obj, oldValue };
        }

        op['nodeId'] = this.id;
        patch.operations.push(op);

        this._setValue(obj);

        if (obj == null) {
            patch.operations.push(...this.clearPathToRoot());
        }

        return patch
    }

    /**
     * TODO: What is this doing?
     * @param {?} obj
     */
    _setValue(obj) {
        if (this.parent && this.parent.obj) {
            if (obj == null) {
                delete this.parent.obj[this.key];
            } else {
                this.parent.obj[this.key] = obj;
            }
        } else if (obj !== undefined && this.constructor === TypedValue) {
            throw Error('Value lost')
        }

        this.refreshUI(false);
    }

    /**
     * @param{number | string | boolean} value
     * @returns {GridChenNS.JSONPatchOperation[]}
     */
    createPathToRoot(value) {
        /** @type{GridChenNS.JSONPatchOperation[]} */
        let operations = [];
        /** @type{FormChenNS.ProxyNode} */
        let n = this.parent;
        /** @type{string | number} */
        let key = this.key;
        while (n && n.obj == null) {
            let empty = n.schema.type === 'array' ? [[], []] : [{}, {}];
            operations.unshift({ op: 'add', path: n.path, value: empty[0], nodeId: n.id });
            n.obj = empty[1];
            n.onNewObjectReference(n.obj);
            n.obj[key] = value;
            key = n.key;
            value = n.obj
            n = n.parent;
        }
        return operations
    }

    /**
     * Removes the value for this node.
     * If the parent holder object thus will become empty, it is also removed.
     * This will continue to the root.
     * @returns {GridChenNS.JSONPatchOperation[]}
     */
    clearPathToRoot() {
        let operations = [];
        /** @type{FormChenNS.ProxyNode} */
        let n = this.parent;
        while (true) {

            if (!n) break
            if (n.obj == null) break;
            if ((n.schema.type === 'object' ? Object.values(n.obj) : n.obj).length === 0) {
                let oldValue = n.obj;
                delete n.obj;
                n.onNewObjectReference(null);
                if (n.parent) {
                    oldValue = n.parent.obj[n.key];
                    delete n.parent.obj[n.key];
                }
                operations.push({ op: 'remove', path: n.path, oldValue, nodeId: n.id });
            } else {
                break;
            }
            n = n.parent;
        }

        return operations
    }

    /**
     * @param {boolean} disabled 
     */
    refreshUI(disabled) {
    }
}

/** 
 * @implements{FormChenNS.ProxyNode} 
 */
export class ProxyNode extends TypedValue {
    /**
     * @param {FormChenNS.Graph} graph
     * @param {string} relId
     * @param {string | number} key
     * @param {GridChenNS.ColumnSchema} schema
     * @param {FormChenNS.ProxyNode} parent
     */
    constructor(graph, relId, key, schema, parent) {
        super(graph, relId, key, schema, parent)
        /** @type{FormChenNS.TypedValue[]} */
        this.children = [];
    }

    getValue() {
        return this.obj;
    }

    _setValue(obj) {
        if (obj == null) {
            delete this.obj;
        } else {
            this.obj = obj;
        }

        super._setValue(obj);

        for (let child of this.children) {
            child._setValue((obj == null ? undefined : obj[child.key]));
        }
    }

    onNewObjectReference(obj) {
        // NoOp
    }

}

/**
 * @param {GridChenNS.ColumnSchema} topSchema
 * @param {object} topObj
 */
export function createFormChen(topSchema, topObj) {
    
    const pathPrefix = topSchema.pathPrefix || '';
    /** @type{FormChenNS.Graph} */
    const graph = new Graph(topSchema);

    // const containerByPath = {};
    // for (const _elem of document.body.querySelectorAll('[data-path]')) {
    //     const elem = /**@type{HTMLElement}*/ (_elem);
    //     const prefixedJsonPath = elem.dataset.path.trim();
    //     if (prefixedJsonPath === pathPrefix || prefixedJsonPath.startsWith(pathPrefix + '/')) {
    //         const jsonPath = prefixedJsonPath.substr(pathPrefix.length);
    //         containerByPath[jsonPath] = elem;
    //         elem.textContent = '';
    //         // /** @param {KeyboardEvent} evt */
    //         // elem.onkeydown = function (evt) {
    //         //     if (evt.code === 'KeyA' && evt.ctrlKey) {
    //         //         alert(evt.target.id)
    //         //     }
    //         // }
    //     }
    // }

    let holder;
    if (['object', 'array'].includes(topSchema.type)) {
        holder = null;
    } else {
        // A leaf node always needs a composit parent.
        holder = new ProxyNode(graph, '', '', { type: 'object' }, null);
        holder.obj = {};
    }

     /**
     * @param {string} relId 
     * @param {string | number} key 
     * @param {GridChenNS.ColumnSchema} schema 
     * @param {FormChenNS.ProxyNode} parent 
     * @returns {FormChenNS.TypedValue}
     */
    function createNode(relId, key, schema, parent) {
        schema = graph.resolveSchema(schema, String(key));
        if (schema.type === 'object' || schema.type === 'array') {
            return new ProxyNode(graph, relId, key, schema, parent);
        } else {
            return new TypedValue(graph, relId, key, schema, parent);
        }
    }

    const transactionManager = registerGlobalTransactionManager();
    const rootNode = createNode('', '', topSchema, holder);
    bindNode(rootNode, undefined); //document.getElementById(rootNode.id));

    rootNode.setValue(topObj);

    /**
     * @param {FormChenNS.ProxyNode} node
     * @param {HTMLElement} container
     */
    function bindObject(node, container) {
        const properties = node.schema.properties || [];
        for (let [key, childSchema] of Object.entries(properties)) {
            const childNode = createNode(key, key, childSchema, node);
            bindNode(childNode, container);
        }
    }

    /**
     * @param {FormChenNS.ProxyNode} masterNode 
     * @param {GridChenNS.MatrixView} view 
     * @param {GridChenNS.GridChen} grid 
     * @param {HTMLElement} container 
     * @param {number} detailIndex 
     * @param {GridChenNS.ColumnSchema} detailSchema 
     */
    function bindDetail(masterNode, view, grid, container, detailIndex, detailSchema) {
        const id = masterNode.id + view.getDetailId(detailIndex);
        detailSchema = graph.resolveSchema(detailSchema, id);

        class DetailNode extends ProxyNode {
            constructor(graph, relId, key, schema, parent) {
                super(graph, relId, key, schema, parent);
                this.grid = grid;
                this.masterNode = masterNode;
                this.rowIndex = 0;
            }
            setRowIndex(rowIndex) {
                const { path, value } = view.getDetail(rowIndex, detailIndex);
                this.obj = value;
                this.path = masterNode.path + path;
                this.rowIndex = rowIndex;
                return value
            }
            onNewObjectReference(obj) {
                view.setDetail(this.rowIndex, detailIndex, obj);
            }
        }

        const detailNode = new DetailNode(graph, id, undefined, detailSchema, null);

        bindNode(detailNode, container);        

        grid.addEventListener('selectionChanged', function () {
            const selection = grid.selectedRange;
            detailNode.setRowIndex(selection.rowIndex);
            const isEmptyRow = view.getRow(selection.rowIndex).every(item => item == null);

            for (const n of detailNode.children) {
                if (n.constructor !== TypedValue) {
                    throw new Error('TODO: Allow nested details');
                }
                n.path = detailNode.path + '/' + n.key; 
                n.refreshUI(isEmptyRow);
            }
        });
    }

    /**
     * @param {FormChenNS.ProxyNode} node
     * @param {HTMLElement} containerElement
     */
    function bindGrid(node, containerElement) {
        const label = document.createElement('label');
        label.className = 'grid-label';
        label.textContent = node.title;
        containerElement.appendChild(label);

        const grid = /** @type{GridChenNS.GridChen} */ (document.createElement('grid-chen'));
        if (node.schema.height) {
            grid.style.height = node.schema.height + 'px';
        }
        label.appendChild(grid);
        node.schema.readOnly = node.readOnly;  // schema is mutated anyway by createView.
        node.schema.pathPrefix = rootNode.schema.pathPrefix + node.path;
        //node.grid = grid;
        const gridSchema = Object.assign({}, node.schema);

        const view = createView(gridSchema, node.obj);
        grid.resetFromView(view, transactionManager);
        view.updateHolder = function () {
            return node.setValue(view.getModel())
        };

        for (const [detailIndex, detailSchema] of view.schema.detailSchemas.entries()) {
            bindDetail(node, view, grid, containerElement, detailIndex, detailSchema);
        }

        node.refreshUI = function () {
            view.applyJSONPatch([{ op: 'replace', path: '', value: node.obj }]);
            grid._refresh();
        }
    }

    /**
     * @param {FormChenNS.ProxyNode} node
     * @param {HTMLElement} container
     */
    function bindTuple(node, container) {
        if (Array.isArray(node.schema.items)) {
            // Fixed length tuple.
            const tupleSchemas = /**@type{GridChenNS.ColumnSchema[]}*/ (node.schema.items);
            for (let [key, childSchema] of Object.entries(tupleSchemas)) {
                const childNode = createNode(key, key, childSchema, node);
                bindNode(childNode, container);
            }
        }
    }

    /**
     * 
     * @param {FormChenNS.TypedValue} node 
     * @param {HTMLElement} container
     */
    function bindNode(node, container) {
        const schema = node.schema;
        const path = node.path;

        const e = document.getElementById(node.id);
        if (e) {
            container = e;
            container.textContent = '';
        }

        if (schema.type === 'object' || schema.type === 'array') {
            console.log('bind: ' + path);

            if (schema.type === 'object') {
                bindObject(/**@type{FormChenNS.ProxyNode}*/(node), container);
                return
            }

            if (schema.type === 'array') {
                if (schema.format === 'grid') {
                    if (container) bindGrid(/**@type{FormChenNS.ProxyNode}*/(node), container);
                } else {
                    bindTuple(/**@type{FormChenNS.ProxyNode}*/(node), container);
                }
                return
            }

        }

        console.log('bind: ' + path);

        if (!container) return

        const label = document.createElement('label');
        let input;

        if (schema.type === 'boolean') {
            input = document.createElement('input');
            input.type = 'checkbox';
            node.refreshUI = function (disabled) {
                const value = this.getValue();
                input.checked = (value == null ? false : value);
                input.disabled = node.readOnly || disabled;
            };
        } else if (schema.enum) {
            input = document.createElement('select');
            schema.enum.forEach(function (optionName) {
                const option = document.createElement('option');
                option.textContent = String(optionName);
                input.appendChild(option);
            });
            node.refreshUI = function (disabled) {
                input.value = this.getValue();
                input.disabled = node.readOnly || disabled;
            };
        } else {
            input = document.createElement('input');
            node.refreshUI = function (disabled) {
                const value = this.getValue();
                if (value == null) {
                    input.defaultValue = input.value = '';
                } else {
                    input.defaultValue = input.value = this.schema.converter.toEditable(value);
                }
                input.disabled = node.readOnly || disabled;
            };

            if (schema.type === 'integer') {
                if (!schema.converter) {
                    schema.converter = new NumberConverter(0);
                }
            } else if (schema.type === 'number') {
                if (!schema.converter) {
                    schema.converter = new NumberConverter(schema.fractionDigits || 2);
                    if (schema.format === '%') {
                        schema.converter.isPercent = true;
                    }
                }
            } else if (schema.format === 'date-time') {
                if (!schema.converter) {
                    schema.converter = new DateTimeStringConverter();
                }
            } else if (schema.format === 'date-partial-time') {
                if (!schema.converter) {
                    schema.converter = new DatePartialTimeStringConverter();
                }
            } else if (schema.format === 'full-date') {
                if (!schema.converter) {
                    schema.converter = new FullDateStringConverter();
                }
            } else if (schema.type === 'string') {
                if (!schema.converter) {
                    schema.converter = new StringConverter();
                }
                if (schema.format === 'color') {
                    input.type = 'color';
                } else {
                    input.type = 'string';
                }
            } else {
                throw Error('Invalid schema at ' + path);
            }
        }

        // if (node.readOnly && !(value == null)) {
        //     input.disabled = true;
        // }

        input.onchange = function () {
            let value;

            if (schema.type === 'boolean') {
                value = input.checked;
            } else if (schema.enum) {
                value = input.value;
            } else {
                const newValue = schema.converter.fromEditable(input.value.trim());
                if (newValue === '') {
                    value = undefined;
                } else {
                    value = newValue;
                }
            }

            const patch = node.setValue(value);
            const trans = transactionManager.openTransaction();
            trans.patches.push(patch);
            trans.commit();
        };

        label.textContent = node.title;

        if (schema.description) {
            label.title = schema.description;
        }

        if (schema.unit) {
            const unit = document.createElement('span');
            unit.className += ' unit';
            unit.textContent = schema.unit;
            label.appendChild(unit);
        }


        label.setAttribute('for', node.id);
        input.id = node.id;
        container.appendChild(label);
        container.appendChild(input);
    }

    /**
     * @implements {FormChenNS.FormChen}
     */
    class FormChen {
        /**
         * Returns the current value of the bound object.
         * @returns {*}
         */
        get value() {
            return rootNode.getValue()
        }

        /**
         * @param {string} id
         * @returns {FormChenNS.TypedValue}
         */
        getNodeById(id) {
            return graph.getNodeById(id);
        }
    }

    return new FormChen();
}
