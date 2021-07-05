import {
  Sequelize,
} from 'sequelize/types';

export const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_ENDPOINT,
    port: parseInt(process.env.DB_PORT, 10),
    dialect: 'mysql',
  },
  // configure pool?
);
