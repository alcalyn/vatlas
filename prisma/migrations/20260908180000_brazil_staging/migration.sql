-- Scratch space for the Brazilian import: `Empresas` is materialised so that the unsorted
-- `Estabelecimentos` stream can be joined against it. Empty between runs.
CREATE TABLE `br_empresa` (
    `cnpj_basico` CHAR(8) NOT NULL,
    `razao_social` VARCHAR(255) NOT NULL,
    `natureza_juridica` CHAR(4) NULL,

    PRIMARY KEY (`cnpj_basico`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
