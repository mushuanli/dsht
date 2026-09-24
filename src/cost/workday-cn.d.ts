declare module 'workday-cn' {
  const workday: { isHoliday(date: Date | string): boolean };
  export default workday;
}
