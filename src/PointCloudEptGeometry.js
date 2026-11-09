import {PointCloudTreeNode} from "./PointCloudTree.js";
import {PointAttributes, PointAttribute, PointAttributeTypes} from "./loader/PointAttributes.js";
import * as THREE from "../libs/three.js/build/three.module.js";

class U {
	static toVector3(v, offset) {
		return new THREE.Vector3().fromArray(v, offset || 0);
	}

	static toBox3(b) {
		return new THREE.Box3(U.toVector3(b), U.toVector3(b, 3));
	};

	static findDim(schema, name) {
		var dim = schema.find((dim) => dim.name == name);
		if (!dim) throw new Error('Failed to find ' + name + ' in schema');
		return dim;
	}

	static sphereFrom(b) {
		return b.getBoundingSphere(new THREE.Sphere());
	}

	static toPotreeName([d, x, y, z]) {
		var name = 'r';

		for (var i = 0; i < d; ++i) {
			var shift = d - i - 1;
			var mask = 1 << shift;
			var step = 0;

			if (x & mask) step += 4;
			if (y & mask) step += 2;
			if (z & mask) step += 1;

			name += step;
		}

		return name;
	}

	static maybeSrs(srs) {
		try { 
			proj4(srs) 
			return srs
		} catch (e) {}
	}
};

class BaseGeometry {
	constructor({ 
		cube,
		boundsConforming,
		spacing,
		srs,
	}) {
		this.cube = cube;

		this.boundingBox = U.toBox3(cube);
		this.tightBoundingBox = U.toBox3(boundsConforming);
		this.boundingSphere = U.sphereFrom(this.boundingBox);
		this.tightBoundingSphere = U.sphereFrom(this.tightBoundingBox);
		this.offset = U.toVector3([0, 0, 0]);
		this.version = new Potree.Version('1.7');

		this.loader = new Potree.CopcLaszipLoader();

		this.spacing = spacing;
		this.projection = srs || null;
		try {
			proj4(this.projection);
		} catch(e) {
			this.projection = null;
		}

		const attributes = new PointAttributes();
		attributes.add(PointAttribute.POSITION_CARTESIAN);
		attributes.add(new PointAttribute("rgba", PointAttributeTypes.DATA_TYPE_UINT8, 4));
		attributes.add(new PointAttribute("intensity", PointAttributeTypes.DATA_TYPE_UINT16, 1));
		attributes.add(new PointAttribute("classification", PointAttributeTypes.DATA_TYPE_UINT8, 1));
		attributes.add(new PointAttribute("gps-time", PointAttributeTypes.DATA_TYPE_FLOAT, 1));
		attributes.add(new PointAttribute("returnNumber", PointAttributeTypes.DATA_TYPE_UINT8, 1));
		attributes.add(new PointAttribute("number of returns", PointAttributeTypes.DATA_TYPE_UINT8, 1));
		attributes.add(new PointAttribute("return number", PointAttributeTypes.DATA_TYPE_UINT8, 1));
		attributes.add(new PointAttribute("source id", PointAttributeTypes.DATA_TYPE_UINT16, 1));
		this.pointAttributes = attributes;
	}
}

// Doit rester en accord avec NORMAL_DIMENSION_SETS du decodeur
// (src/workers/EptLaszipDecoderWorker.js) : declarer un attribut que le
// decodeur ne remplit pas donnerait un nuage noir sans explication.
//
// Constante de module et non champ statique : rollup 1.x, employe par le build
// de Potree, ne sait pas analyser les champs statiques de classe.
const NORMAL_EXTRA_BYTE_NAMES = [
	['NormalX', 'NormalY', 'NormalZ'],
	['normal x', 'normal y', 'normal z'],
	['nx', 'ny', 'nz'],
];

export class PointCloudCopcGeometry extends BaseGeometry {
	static parse({ header, info, wkt }) {
		return {
			cube: info.cube,
			boundsConforming: [...header.min, ...header.max],
			spacing: info.spacing,
			srs: wkt,
		}
	}

	constructor(getter, copc) {
		super(PointCloudCopcGeometry.parse(copc))

		this.type = 'copc';
		this.getter = getter
		this.copc = copc;
		this.pages = { '0-0-0-0': copc.info.rootHierarchyPage }

		this.loader = new Potree.CopcLaszipLoader();

		// Les normales arrivent en "extra bytes" et ne figurent donc pas dans la
		// liste d'attributs standard. On les declare quand le fichier en porte,
		// pour qu'elles apparaissent comme les autres — notamment dans les
		// interfaces qui listent les colorations disponibles.
		const ebNames = (copc.eb || []).map((e) => (e && e.name ? e.name : ''));
		const hasNormals = NORMAL_EXTRA_BYTE_NAMES.some(
			(set) => set.every((name) => ebNames.includes(name))
		);
		if (hasNormals) {
			this.pointAttributes.add(
				new PointAttribute("normal", PointAttributeTypes.DATA_TYPE_FLOAT, 3));
		}
	}

	async loadHierarchyPage(key) {
		const { Copc, Key } = window.Copc
		const page = this.pages[Key.toString(key)]
		return Copc.loadHierarchyPage(this.getter, page)
	}
};

export class PointCloudEptGeometry extends BaseGeometry {
	static parse(ept) {
		const { bounds: cube, boundsConforming, span, srs: filesrs } = ept

		const spacing = (cube[3] - cube[0]) / span

		let srs
		if (filesrs) {
			const { authority, horizontal, wkt } = filesrs
			if (authority && horizontal) {
				srs = U.maybeSrs(`${authority}:${horizontal}`)
			}
			if (!srs && wkt) srs = U.maybeSrs(wkt)
		}

		return { cube, boundsConforming, spacing, srs }
	}

	constructor(base, ept) {
		super(PointCloudEptGeometry.parse(ept))

		this.type = 'ept';
		this.base = base;
		this.ept = ept;

		this.loader = (() => {
			switch (ept.dataType) {
				case 'laszip': return new Potree.EptLaszipLoader()
				case 'binary': return new Potree.EptBinaryLoader()
				case 'zstandard': return new Potree.EptZstandardLoader()
				default: throw new Error('Invalid data type: ' + ept.dataType)
			}
		})()
	}

	async loadHierarchyPage(key) {
		const { Ept, Key } = window.Copc

		const filename = `${this.base}/ept-hierarchy/${Key.toString(key)}.json`
		const response = await fetch(filename);
		const json = await response.json();
		return Ept.Hierarchy.parse(json)
	}
}

// Apres un echec de chargement, attente avant de reessayer le meme noeud : elle double a chaque
// echec, jusqu'au plafond. Sans elle, le noeud serait redemande a chaque image.
const ATTENTE_ESSAI_MS = 1000;
const ATTENTE_ESSAI_MAX_MS = 30000;

export class PointCloudCopcGeometryNode extends PointCloudTreeNode {
	constructor(owner, key, bounds) {
		super();

		const { Key } = Copc

		this.owner = owner
		this.key = key || Key.create(0, 0, 0, 0)
		this.bounds = bounds || owner.cube

		this.id = PointCloudCopcGeometryNode.IDCount++;
		this.geometry = null;
		this.boundingBox = U.toBox3(this.bounds)
		this.tightBoundingBox = this.boundingBox;
		this.spacing = this.owner.spacing / Math.pow(2, Key.depth(this.key));
		this.boundingSphere = U.sphereFrom(this.boundingBox);

		// These are set during hierarchy loading.
		this.hasChildren = false;
		this.children = { };
		this.nodeinfo = undefined
		this.numPoints = -1;

		this.level = Key.depth(this.key);
		this.loaded = false;
		this.loading = false;
		this.oneTimeDisposeHandlers = [];

		this.name = U.toPotreeName(this.key);
		this.index = parseInt(this.name.charAt(this.name.length - 1));
	}

	isGeometryNode() { return true; }
	getLevel() { return this.level; }
	isTreeNode() { return false; }
	isLoaded() { return this.loaded; }
	getBoundingSphere() { return this.boundingSphere; }
	getBoundingBox() { return this.boundingBox; }
	getNumPoints() { 
		return this.nodeinfo ? this.nodeinfo.pointCount : -1; 
	}

	getChildren() {
		let children = [];

		for (let i = 0; i < 8; i++) {
			if (this.children[i]) {
				children.push(this.children[i]);
			}
		}

		return children;
	}

	addChild(child) {
		this.children[child.index] = child;
		child.parent = this;
	}

	async load() {
		if (this.loaded || this.loading) return;
		if (Potree.numNodesLoading >= Potree.maxNodesLoading) return;
		if (this.prochainEssai && performance.now() < this.prochainEssai) return;

		this.loading = true;
		++Potree.numNodesLoading;

		try {
			if (!this.nodeinfo) await this.loadHierarchy();
			await this.loadPoints();
		} catch (erreur) {
			this.chargementEchoue(erreur);
		}
	}

	loadPoints(){
		return this.owner.loader.load(this);
	}

	// Une place est prise exactement tant que `loading` est vrai : la rendre deux fois est impossible.
	libererPlace() {
		if (!this.loading) return;
		this.loading = false;
		--Potree.numNodesLoading;
	}

	// Sans cela, un chargement echoue gardait sa place pour toujours : une fois toutes les places
	// prises, plus aucun point ne se chargeait.
	chargementEchoue(erreur) {
		this.libererPlace();
		this.echecs = (this.echecs || 0) + 1;
		this.prochainEssai = performance.now() + Math.min(ATTENTE_ESSAI_MAX_MS, ATTENTE_ESSAI_MS * 2 ** (this.echecs - 1));
		if (this.echecs === 1) console.warn("Chargement d'un noeud du nuage impossible, nouvel essai bientot :", erreur);
	}

	async loadHierarchy() {
		const { Bounds, Key } = window.Copc
		const ourkeyname = Key.toString(this.key)

		let nodemap = { };
		nodemap[ourkeyname] = this;
		this.hasChildren = false;

		const { nodes, pages } = await this.owner.loadHierarchyPage(this.key)

		// Since we want to traverse top-down, and 10 comes lexicographically 
		// before 9 (for example), do a deep sort.
		const keys = Object.keys({ ...nodes, ...pages })
			.map(Key.create)
			.sort(Key.compare)

		keys.forEach((key) => {
			const keyname = Key.toString(key)
			if (keyname === ourkeyname) {
				this.nodeinfo = nodes[keyname]
				return;
			}

			const [_d, x, y, z] = key
			const step = [x & 1, y & 1, z & 1]

			let parentName = Key.toString(Key.up(key))
			let parentNode = nodemap[parentName];
			if (!parentNode) return;
			parentNode.hasChildren = true;

			const bounds = Bounds.step(parentNode.bounds, step)
			const node = new Potree.PointCloudCopcGeometryNode(
				this.owner,
				key, 
				bounds);
			parentNode.addChild(node);
			nodemap[keyname] = node;

			// For data nodes, add their point data offset/point counts.
			const nodeinfo = nodes[keyname]
			if (nodeinfo) node.nodeinfo = nodeinfo

			// And for leaf nodes whose data is in a different hierarchy page, 
			// store the info for the hierarchy page in our page map.  This is
			// only applicable for COPC data since we need hierarchy page 
			// ranges to fetch them - EPT data on the other hand we just need
			// the node key to fetch the file.
			const pageinfo = pages[keyname]
			if (this.owner.pages && pageinfo) {
				this.owner.pages[keyname] = pageinfo
			}
		})
	}

	doneLoading(bufferGeometry, tightBoundingBox, np, mean) {
		// Une reponse tardive, alors qu'un nouvel essai a deja abouti.
		if (this.loaded) {
			bufferGeometry.dispose();
			return;
		}
		bufferGeometry.boundingBox = this.boundingBox;
		this.geometry = bufferGeometry;
		this.tightBoundingBox = tightBoundingBox;
		this.numPoints = np;
		this.mean = mean;
		this.loaded = true;
		this.echecs = 0;
		this.prochainEssai = 0;
		this.libererPlace();
	}

	dispose() {
		if (this.geometry && this.parent) {
			this.geometry.dispose();
			this.geometry = null;
			this.loaded = false;

			// this.dispatchEvent( { type: 'dispose' } );
			for (let i = 0; i < this.oneTimeDisposeHandlers.length; i++) {
				let handler = this.oneTimeDisposeHandlers[i];
				handler();
			}
			this.oneTimeDisposeHandlers = [];
		}
	}
}

PointCloudCopcGeometryNode.IDCount = 0;
