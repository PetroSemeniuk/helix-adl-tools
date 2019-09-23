import * as adlast from './adl-gen/sys/adlast';
import * as adl from "./adl-gen/runtime/adl";
import { collect, scopedName, scopedNamesEqual, expandNewType, expandTypeAlias, parseAdl, forEachDecl, getAnnotation, decodeTypeExpr, DecodedTypeExpr } from "./util";
import * as fs from "fs";
import { isEnum, typeExprToStringUnscoped } from './adl-gen/runtime/utils';
import { Command } from "commander";
import { snakeCase } from "change-case";

export function configureCli(program: Command) {
  program
   .command("sql [adlFiles...]")
   .option('-I, --searchdir <path>', 'Add to adl searchpath', collect, [])
   .option('--outfile <path>', 'the resulting sql file', 'create.sql')
   .option('--outputdir <dir>', 'the directory into which the sql is written (deprecated)')
   .option('--postgres', 'Generate sql for postgres')
   .option('--postgres-v2', 'Generate sql for postgres (model version 2)')
   .option('--mssql', 'Generate sql for microsoft sqlserver')
   .description('Generate a db schema from ADL files')
   .action( (adlFiles:string[], cmd:{}) => {
     const adlSearchPath: string[] = cmd['searchdir'];

     let outfile: string = cmd['outfile'];
     if (cmd['outputdir']) {
       outfile = cmd['outputdir'] + '/create.sql';
     }

     let dbProfile = postgresDbProfile;
     if (cmd['postgresV2']) {
       dbProfile = postgres2DbProfile;
     }
     if (cmd['mssql']) {
       dbProfile = mssql2DbProfile;
     }

     generateSqlSchema({adlFiles, adlSearchPath, outfile, dbProfile});
   });
}

export interface Params {
  adlFiles: string[];
  adlSearchPath: string[];
  outfile: string;
  dbProfile: DbProfile;
};

export async function generateSqlSchema(params: Params): Promise<void> {
  // Load the ADL based upon command line arguments
  const loadedAdl = await parseAdl(params.adlFiles, params.adlSearchPath);

  // Find all of the struct declarations that have a DbTable annotation
  const dbTables: {
    scopedDecl: adlast.ScopedDecl,
    struct: adlast.DeclType_Struct_,
    ann:{}|null,
    name:string
  }[]  = [];

  forEachDecl(loadedAdl.modules, scopedDecl => {
    if (scopedDecl.decl.type_.kind == 'struct_') {
      const struct = scopedDecl.decl.type_;
      const ann = getAnnotation(scopedDecl.decl.annotations, DB_TABLE);
      if (ann != undefined) {
        const name = getTableName(scopedDecl);
        dbTables.push({scopedDecl, struct, ann, name});
      }
    }
  });
  dbTables.sort( (t1, t2) => t1.name < t2.name ? -1 : t1.name > t2.name ? 1 : 0);

  // Now generate the SQL file
  const writer = fs.createWriteStream(params.outfile);
  const moduleNames : Set<string> = new Set(dbTables.map(dbt => dbt.scopedDecl.moduleName));
  writer.write( `-- Schema auto-generated from adl modules: ${Array.from(moduleNames.keys()).join(', ')}\n` );
  writer.write( `--\n` );
  writer.write( `-- column comments show original ADL types\n` );


  const constraints: string[] = [];
  let allExtraSql: string[] = [];

  // Output the tables
  for(const t of dbTables) {
    const withIdPrimaryKey: boolean  = t.ann && t.ann['withIdPrimaryKey'] || false;
    const withPrimaryKey: string[] = t.ann && t.ann['withPrimaryKey'] || [];
    const indexes: string[][] = t.ann && t.ann['indexes'] || [];
    const uniquenessConstraints: string[][] = t.ann && t.ann['uniquenessConstraints'] || [];
    const extraSql: string[] = t.ann && t.ann['extraSql'] || [];

    const lines: {code:string, comment?:string}[] = [];
    if (withIdPrimaryKey) {
      lines.push({code: `id ${params.dbProfile.idColumnType} not null`});
    }
    for(const f of t.struct.value.fields) {
      const columnName = getColumnName(f);
      const columnType = getColumnType(loadedAdl.resolver, f.typeExpr, params.dbProfile);
      lines.push({
        code: `${columnName} ${columnType.sqltype}`,
        comment: tweakTypeComment (typeExprToStringUnscoped(f.typeExpr)),
      });
      if (columnType.fkey) {
        constraints.push(`alter table ${t.name} add constraint ${t.name}_${columnName}_fk foreign key (${columnName}) references ${columnType.fkey.table}(${columnType.fkey.column});`);
      }
    }

    function findColName(s: string):string {
      for(const f of t.struct.value.fields) {
        if (f.name == s) {
          return getColumnName(f);
        }
      }
      return s;
    }

    for(let i = 0; i < indexes.length; i++) {
      const cols = indexes[i].map(findColName);
      constraints.push(`create index ${t.name}_${i+1}_idx on ${t.name}(${cols.join(', ')});`);
    }
    for(let i = 0; i < uniquenessConstraints.length; i++) {
      const cols = uniquenessConstraints[i].map(findColName);
      constraints.push(`alter table ${t.name} add constraint ${t.name}_${i+1}_con unique (${cols.join(', ')});`);
    }
    if (withIdPrimaryKey) {
      lines.push({code:'primary key(id)'});
    } else if (withPrimaryKey.length > 0) {
      const cols = withPrimaryKey.map(findColName);
      lines.push({code:`primary key(${cols.join(',')})`});
    }


    writer.write('\n');
    writer.write( `create table ${t.name}(\n` );
    for(let i = 0; i < lines.length; i++) {
      let line = lines[i].code;
      if (i < lines.length-1) {
        line += ',';
      }
      if (lines[i].comment) {
        line = line.padEnd(36, ' ');
        line = line + " -- " + lines[i].comment;
      }
      writer.write('  ' + line + '\n');
    }
    writer.write( `);\n` );
    allExtraSql = allExtraSql.concat(extraSql);
  }

  if(constraints.length > 0) {
    writer.write('\n');
  }

  for(const constraint of constraints) {
    writer.write(constraint + '\n');
  }

  if(allExtraSql.length > 0) {
    writer.write('\n');
  }

  // And any sql
  for(const sql in allExtraSql) {
    writer.write(sql + '\n');
  }
}

/**
 *  Returns the SQL name for the table
 */
function getTableName(scopedDecl: adlast.ScopedDecl): string {
  const ann = getAnnotation(scopedDecl.decl.annotations, DB_TABLE);
  if (ann && typeof ann['tableName'] == 'string') {
    return ann['tableName'];
  }
  return snakeCase(scopedDecl.decl.name);
}

/**
 * Returns the SQL name for a column corresponding to a field
 */
function getColumnName(field: adlast.Field): string {
  const ann = getAnnotation(field.annotations, DB_COLUMN_NAME);
  if (typeof ann === "string") {
    return ann;
  }
  return snakeCase(field.name);
}

interface ColumnType {
  sqltype: string;
  fkey? : {
    table: string,
    column: string
  };
};


function getColumnType(resolver: adl.DeclResolver, typeExpr: adlast.TypeExpr, dbProfile: DbProfile): ColumnType {
  // For Maybe<T> and Nullable<T> the sql column will allow nulls
  const dtype = decodeTypeExpr(typeExpr);
  if(dtype.kind == 'Nullable' ||
     dtype.kind == 'Reference' && scopedNamesEqual(dtype.refScopedName, MAYBE)
    ) {
    return {
      sqltype: getColumnType1(resolver, typeExpr.parameters[0], dbProfile),
      fkey: getForeignKeyRef(resolver, typeExpr.parameters[0])
    };
  }

  // For all other types, the column will not allow nulls
  return {
    sqltype: getColumnType1(resolver, typeExpr, dbProfile) + " not null",
    fkey: getForeignKeyRef(resolver, typeExpr)
  };
}

function getColumnType1(resolver: adl.DeclResolver, typeExpr: adlast.TypeExpr, dbProfile: DbProfile): string {
  const dtype = decodeTypeExpr(typeExpr);
  switch(dtype.kind) {
    case "Reference":
      const sdecl = resolver(dtype.refScopedName);

      if (scopedNamesEqual(dtype.refScopedName, INSTANT)) {
        return "timestamp";
      } else if (scopedNamesEqual(dtype.refScopedName, LOCAL_DATE)) {
        return "date";
      } else if (scopedNamesEqual(dtype.refScopedName, LOCAL_DATETIME)) {
        return "timestamp";
      } else if (sdecl.decl.type_.kind == 'union_' && isEnum(sdecl.decl.type_.value)) {
        return dbProfile.enumColumnType;
      }
      // If we have a reference to a newtype or type alias, resolve
      // to the underlying type
      let texpr2 = null;
      texpr2 = texpr2 || expandTypeAlias(resolver, typeExpr);
      texpr2 = texpr2 || expandNewType(resolver, typeExpr);
      if (texpr2) {
        return getColumnType1(resolver, texpr2, dbProfile);
      }
    default:
      return dbProfile.primColumnType(dtype.kind);
  }
}

function getForeignKeyRef(resolver: adl.DeclResolver, typeExpr: adlast.TypeExpr): {table:string, column:string} | undefined {
  const dtype = decodeTypeExpr(typeExpr);
  if (dtype.kind == 'Reference' && scopedNamesEqual(dtype.refScopedName, DB_KEY)) {
    const param0 = dtype.parameters[0];
    if (param0.kind == 'Reference') {
      return {table:getTableName(resolver(param0.refScopedName)), column:"id"};
    }
  }
  return undefined;
}


// A few text changes to comments to make them consistent with the old generator
function tweakTypeComment(comment: string): string {
  return comment
    .replace("DbKey", "common.db.DbKey")
    .replace("Instant", "common.Instant");
}

// Contains customizations for the db mapping
interface DbProfile {
  idColumnType : string;
  enumColumnType: string;
  primColumnType(ptype: string): string;
};

const postgresDbProfile: DbProfile = {
  idColumnType: "text",
  enumColumnType: "text",
  primColumnType(ptype: string): string {
    switch (ptype) {
    case "String": return "text";
    case "Bool": return "boolean";
    case "Json": return "json";
    case "Int8" : return "smallint";
    case "Int16" : return "smallint";
    case "Int32" : return "integer";
    case "Int64" : return "bigint";
    case "Word8" : return "smallint";
    case "Word16" : return "smallint";
    case "Word32" : return "integer";
    case "Word64" : return "bigint";
    case "Float": return "real";
    case "Double": return "double precision";
    }
    return "json";
  }
};

const postgres2DbProfile: DbProfile = {
  idColumnType: "text",
  enumColumnType: "text",
  primColumnType(ptype: string): string {
    switch (ptype) {
    case "String": return "text";
    case "Bool": return "boolean";
    case "Json": return "jsonb";
    case "Int8" : return "smallint";
    case "Int16" : return "smallint";
    case "Int32" : return "integer";
    case "Int64" : return "bigint";
    case "Word8" : return "smallint";
    case "Word16" : return "smallint";
    case "Word32" : return "integer";
    case "Word64" : return "bigint";
    case "Float": return "real";
    case "Double": return "double precision";
    }
    return "jsonb";
  }
};


const mssql2DbProfile: DbProfile = {
  idColumnType: "nvchar(64)",
  enumColumnType: "nvchar(64)",
  primColumnType(ptype: string): string {
    switch (ptype) {
    case "String": return "nvarchar(max)";
    case "Int8" : return "smallint";
    case "Int16" : return "smallint";
    case "Int32" : return "int";
    case "Int64" : return "bigint";
    case "Word8" : return "smallint";
    case "Word16" : return "smallint";
    case "Word32" : return "int";
    case "Word64" : return "bigint";
    case "Float": return "float(24)";
    case "Double": return "float(53)";
    case "Bool": return "bit";
    }
    return "nvarchar(max)";
  }
};




const MAYBE = scopedName("sys.types", "Maybe");
const DB_TABLE = scopedName("common.db", "DbTable");
const DB_COLUMN_NAME = scopedName("common.db", "DbColumnName")
const DB_KEY = scopedName("common.db", "DbKey")
const INSTANT = scopedName("common", "Instant");
const LOCAL_DATE = scopedName("common", "LocalDate");
const LOCAL_DATETIME = scopedName("common", "LocalDateTime");

