/**
 * Notebook.
 *
 * Manage state of the notebook.
 *
 * @link   https://github.com/CermakM/jupyter-nbrequirements#readme
 * @file   This file implements functionality to manage the notebook state.
 * @author Marek Cermak <macermak@redhat.com>
 * @since  0.0.1
 */

import $ from "jquery"
import _ from "lodash"

import { Logger } from "./config"

import { Requirements, RequirementsLocked, ResolutionEngine } from "./types/requirements"

import { KernelInfo, KernelInfoProxy, KernelSpec } from "./proto/kernel"
import { CodeCell } from "./types/nb"
import {
    PackageVersion,
    Source,
    gather_library_usage,
    lock_requirements,
    lock_requirements_with_pipenv
} from "./thoth"

// Jupyter runtime environment
// @ts-ignore
import Jupyter = require( "base/js/namespace" )
// @ts-ignore
import nbutils = require( "base/js/utils" )
// @ts-ignore
import events = require( "base/js/events" )

declare const DEFAULT_RESOLUTION_ENGINE: ResolutionEngine


// Hang the functions on Jupyter.Notebook prototype for easier usage
Jupyter.Notebook.prototype.set_requirements = _.partial( set_requirements, Jupyter.notebook )
Jupyter.Notebook.prototype.get_requirements = _.partial( get_requirements, Jupyter.notebook )

Jupyter.Notebook.prototype.set_requirements_locked = _.partial( set_requirements_locked, Jupyter.notebook )
Jupyter.Notebook.prototype.get_requirements_locked = _.partial( get_requirements_locked, Jupyter.notebook )

Jupyter.Notebook.prototype.get_kernel_info = _.partial( get_kernel_info, Jupyter.notebook )

Object.defineProperty( window, "__execution_count__", {
    // Count total number of executions in the current session on a cell basis
    value: get_execution_count(),
    writable: true
} )

events.on( "kernel_ready.Kernel", () => {
    // @ts-ignore
    window.__execution_count__ = 0
} )
events.on( "execute.CodeCell", () => {
    // @ts-ignore
    window.__execution_count__ += 1
} )

function get_execution_count(): number {
    let total = 0

    Jupyter.notebook.get_cells().forEach( ( cell: CodeCell ) => {
        if ( cell.cell_type === "code" ) {
            const data = cell.toJSON()

            total += data.execution_count || 0
        }
    } )

    return total
}


export function set_requirements( notebook: Jupyter.Notebook, requirements: Requirements ): void {
    const metadata = notebook.metadata

    if ( _.isUndefined( metadata.requirements ) ) {
        metadata.requirements = requirements
    } else {
        Logger.debug( "Notebook requirements already exist. Updating." )
        // update the notebook metadata
        _.assign( metadata.requirements, requirements )
    }

    Logger.log( "Notebook requirements have been set successfully." )
}

export function get_requirements( notebook: Jupyter.Notebook, ignore_metadata: boolean = false ): Promise<Requirements> {
    return new Promise( async ( resolve, reject ) => {
        Logger.log( "Reading notebook requirements." )

        let notebook_metadata: Requirements | {} = notebook.metadata.requirements || {}
        const aliases = _.get( notebook_metadata, "aliases" ) || {}

        Logger.log( "Gathering library usage." )
        try {
            const library_usage: string[] = await gather_library_usage()
            const python_packages: { [ name: string ]: any } = {}

            library_usage.forEach( ( p: string ) => {
                let python_package_name = p.toLocaleLowerCase()
                if ( _.has( aliases, python_package_name ) ) {
                    // replace the package name by alias
                    python_package_name = aliases[ python_package_name ]
                }

                const python_package = new PackageVersion( python_package_name )

                _.assign(
                    python_packages,
                    python_package.get_pipfile_entry()
                )
            } )

            const requires = { python_version: get_python_version( notebook ) }
            const notebook_requirements: Requirements = {
                aliases: aliases,
                packages: python_packages,
                requires: requires,
                sources: [
                    new Source()
                ]
            }

            if ( ignore_metadata ) {
                resolve( notebook_requirements )
                return
            }

            // Resolve with both the metadata and library usage otherwise
            // The requirements defined in metadata take preference as they can
            // have a specific version pinned down.
            notebook_metadata = _.merge( notebook_requirements, notebook_metadata )
            resolve( notebook_metadata as Requirements )

        } catch ( err ) {
            reject( err )
        }
    } )
}


export function set_requirements_locked( notebook: Jupyter.Notebook, requirements_locked: RequirementsLocked ) {
    const metadata: any = notebook.metadata

    if ( _.isUndefined( metadata.requirements_locked ) ) {
        metadata.requirements_locked = requirements_locked
    } else {
        Logger.debug( "requirements_locked already exist. Updating." )
        // update the notebook metadata
        _.assign( metadata.requirements_locked, requirements_locked )
    }

    Logger.log( "Notebook locked requirements have been set successfully." )
}

export function get_requirements_locked(
    notebook: Jupyter.Notebook,
    ignore_metadata = false,
    dev_packages = false,
    pre_releases = false,
    sync = true,
    engine: ResolutionEngine = DEFAULT_RESOLUTION_ENGINE
): Promise<RequirementsLocked> {
    return new Promise( async ( resolve, reject ) => {
        Logger.log( "Reading notebook locked requirements." )

        const requirements_locked: RequirementsLocked | undefined = notebook.metadata.requirements_locked
        if ( _.isUndefined( requirements_locked ) || ignore_metadata ) {
            Logger.log( "Locked requirements are not defined." )

            switch ( engine ) {
                case "thoth": {
                    lock_requirements( undefined, sync )
                        .then( ( req_locked: RequirementsLocked ) => {
                            resolve( req_locked )
                        } )
                        .catch( ( err: string ) => reject( new Error( err ) ) )

                    break
                }
                case "pipenv": {
                    lock_requirements_with_pipenv( dev_packages, pre_releases, sync )
                        .then( ( req_locked: RequirementsLocked ) => {
                            resolve( req_locked )
                        } )
                        .catch( ( err: string ) => reject( new Error( err ) ) )

                    break
                }
                case "micropipenv": {
                    reject( new Error( "Pipfile.lock must be provided for `micropipenv` engine" ) )

                    break
                }

                default: throw new Error( `Unknown resolution engine: ${ engine }` )
            }

            return
        }

        resolve( requirements_locked )
    } )
}

export function load_kernel( name: string ): Promise<string> {
    return new Promise( async ( resolve ) => {
        const kernel_name: string = name.toLowerCase()
        const kernel_selector = Jupyter.notebook.kernel_selector

        if ( !_.has( kernel_selector.kernelspecs, kernel_name ) )
            // Request kernel specifications
            // This function adds kernels to the notebook toolbar as well
            await load_kernelspecs( Jupyter.notebook, kernel_name )

        resolve( kernel_name )
    } )
}

export async function load_kernelspecs( notebook: Jupyter.Notebook, name: string ): Promise<void> {
    const url = nbutils.url_path_join( notebook.base_url, "api/kernelspecs" )

    const data: { kernelspecs: any } = await nbutils.promising_ajax( url )
    const kernelspecs = data.kernelspecs
    if ( _.isUndefined( kernelspecs[ name ] ) )
        throw new Error( `Unknown kernel: ${ name }` )

    Jupyter.notebook.kernel_selector.kernelspecs = kernelspecs

    const spec: KernelSpec = kernelspecs[ name ]
    const menu = $( "#menu-change-kernel-submenu" )

    menu.append(
        $( "<li>" ).attr( "id", "kernel-submenu-" + spec.name ).append(
            $( "<a>" )
                .attr( "href", "#" )
                .click( function () {
                    set_kernel( spec.name )
                } )
                .text( spec.spec.display_name )
        )
    )

    const children = menu.children( "li" )

    menu.append( Array.from( children ).sort() )
}

export function set_kernel( name: string | undefined ): Promise<string> {
    return new Promise( async ( resolve, reject ) => {
        let kernel_name: string = name || Jupyter.notebook.notebook_name
            .replace( ".ipynb", "" )
            .replace( /\s+/g, "_" )

        kernel_name = kernel_name.toLowerCase()
        const kernel_selector = Jupyter.notebook.kernel_selector

        Logger.log( `Setting kernel: ${ kernel_name }.` )

        if ( kernel_selector.current_selection === kernel_name ) {
            Logger.log( `Kernel ${ kernel_name } is already set.` )

            return resolve( kernel_name )
        }

        // make sure kernelspec exists
        if ( !_.has( kernel_selector.kernelspecs, kernel_name ) ) {
            return reject( new Error( `Missing kernel spec: ${ kernel_name }` ) )
        }

        kernel_selector.set_kernel( kernel_name )

        resolve( kernel_name )
    } )
}

export function get_kernel_info( notebook: Jupyter.Notebook ): KernelInfo {
    const json: string = JSON.stringify( notebook.kernel.info_reply )
    if ( _.isUndefined( json ) ) {
        throw Error( "Unable to retrieve Kernel info" )
    }

    // Parse and perform type check
    const info: KernelInfo = KernelInfoProxy.Parse( json )

    return info
}

export function get_python_version( notebook: Jupyter.notebook ): string {
    const kernel_info = get_kernel_info( notebook )
    const python_version: string = kernel_info.language_info.version

    const match = python_version.match( /\d.\d/ )
    if ( match == null ) {
        throw new Error( `Python version '${ match }' does not match required pattern.` )
    }

    return match[ 0 ]
}
