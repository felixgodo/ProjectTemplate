CREATE TABLE note (
    id         BIGINT       NOT NULL AUTO_INCREMENT,
    text       VARCHAR(500) NOT NULL,
    created_at DATETIME(6)  NOT NULL,
    PRIMARY KEY (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
