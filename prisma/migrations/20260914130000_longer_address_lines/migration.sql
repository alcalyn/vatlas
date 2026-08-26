-- Registers outside Europe do not respect 255 characters: the Japanese one writes the address in
-- full-width characters and appends the place of business to it, which alone runs past 400. The
-- import died on `ER_DATA_TOO_LONG` rather than storing a shortened address.
--
-- Safe on the production table at 200 M rows, and the two clauses are what make that a promise
-- rather than a hope. Extending a VARCHAR is an in-place, metadata-only change *as long as the
-- length prefix keeps its size*: utf8mb4 makes 255 characters 1020 bytes, already past the
-- 255-byte boundary where the prefix goes from one byte to two, and 512 characters is 2048 bytes
-- on the same side of it. No index covers either column, so nothing has to be rebuilt.
-- `ALGORITHM=INPLACE, LOCK=NONE` states both expectations: if this server would instead copy the
-- table or block writes for the duration, it refuses the statement rather than doing it quietly.
ALTER TABLE `company`
    MODIFY COLUMN `address_line1` VARCHAR(512) NULL,
    MODIFY COLUMN `address_line2` VARCHAR(512) NULL,
    ALGORITHM=INPLACE, LOCK=NONE;
